import "dotenv/config";
import fs from "fs";
import path from "path";
import { parse } from "csv-parse";
import { DataAPIClient } from "@datastax/astra-db-ts";
import OpenAI from "openai";

// Environment variables
const {
  NEXT_ASTRA_DB_API_ENDPOINT,
  NEXT_ASTRA_DB_APPLICATION_TOKEN,
  NEXT_ASTRA_DB_NAMESPACE,
  NEXT_ASTRA_DB_COLLECTION,
  NEXT_PUBLIC_OPENAI_API_KEY
} = process.env;

// Initialize clients
const openai = new OpenAI({ apiKey: NEXT_PUBLIC_OPENAI_API_KEY });
const client = new DataAPIClient(NEXT_ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(NEXT_ASTRA_DB_API_ENDPOINT, { keyspace: NEXT_ASTRA_DB_NAMESPACE });

// Path to CSV file
const csvFilePath = path.resolve(__dirname, "../data/faq_clean.csv");

// Track statistics
let successCount = 0;
let errorCount = 0;

// Function to clean and normalize text
const cleanText = (text) => {
  if (!text) return "";
  return text.trim()
    .replace(/\s+/g, ' ')    // Replace multiple spaces with a single space
    .replace(/\n\s*\n/g, '\n'); // Replace multiple newlines with a single newline
};

// Enhanced function to create enriched text for better embedding
const createSearchableText = (record) => {
  const { Kategorie, Titel, Frage, Antwort } = record;
  
  // Create different variations of the question to improve semantic search
  const questionVariations = [];
  
  // Original question
  if (Frage) questionVariations.push(Frage);
  
  // Question without question marks
  if (Frage) questionVariations.push(Frage.replace(/\?/g, ''));
  
  // Keywords from question (remove common words)
  if (Frage) {
    const keywords = Frage
      .replace(/\?/g, '')
      .replace(/(\b(wie|was|wo|wann|warum|wer|welche|welcher|welches|kann|ist|sind|hat|haben|darf|müssen|soll|können|ich|du|er|sie|es|wir|ihr|sie|the|a|an|in|for|to|is|are|can|do|does|with|about|my|your|their)\b)/gi, '')
      .trim();
    questionVariations.push(keywords);
  }
  
  // Add language variations if the question is in English or German
  const isEnglish = /[a-zA-Z]/.test(Frage) && !/[äöüÄÖÜß]/.test(Frage);
  if (isEnglish) {
    // Add common German translations of query terms
    if (Frage.includes('exam')) questionVariations.push('Prüfung Examen');
    if (Frage.includes('course')) questionVariations.push('Kurs Vorlesung');
    if (Frage.includes('register')) questionVariations.push('anmelden registrieren');
    if (Frage.includes('deregister')) questionVariations.push('abmelden');
    if (Frage.includes('deadline')) questionVariations.push('Frist Deadline');
  } else {
    // Add common English translations of query terms
    if (Frage.includes('Prüfung')) questionVariations.push('exam examination');
    if (Frage.includes('Kurs') || Frage.includes('Vorlesung')) questionVariations.push('course lecture');
    if (Frage.includes('anmeld')) questionVariations.push('register registration');
    if (Frage.includes('abmeld')) questionVariations.push('deregister deregistration');
    if (Frage.includes('Frist')) questionVariations.push('deadline');
  }
  
  // Combine all text for enriched embedding
  return `
    KATEGORIE: ${Kategorie || ''}
    TITEL: ${Titel || ''}
    FRAGE: ${Frage || ''}
    FRAGE VARIATIONEN: ${questionVariations.join(' | ')}
    ANTWORT: ${Antwort || ''}
    SUCHBEGRIFFE: ${[Kategorie, Titel, ...questionVariations].filter(Boolean).join(' ')}
  `.trim();
};

// Main data loading function
const loadCSVData = async () => {
  // First, ensure the collection exists (create if not)
  await ensureCollectionExists(NEXT_ASTRA_DB_COLLECTION);
  
  const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION);
  
  // Process records in batches for efficiency
  const batchSize = 5;
  let batch = [];
  let processedCount = 0;
  
  console.log("🚀 Starting FAQ CSV processing...");
  
  const parser = fs
    .createReadStream(csvFilePath)
    .pipe(parse({
      columns: true,
      skip_empty_lines: true,
      trim: true
    }));
  
  for await (const record of parser) {
    const { Kategorie, Titel, Frage, Datum, Antwort, NameAntwortgeber } = record;
    
    // Skip empty records
    if (!Frage || !Antwort) {
      console.log(`⚠️ Skipping incomplete record: ${Titel || '(No title)'}`);
      continue;
    }
    
    // Clean text fields
    const cleanedQuestion = cleanText(Frage);
    const cleanedAnswer = cleanText(Antwort);
    
    // Create display text for storage
    const displayText = `
KATEGORIE: ${Kategorie || 'Keine Kategorie'}
TITEL: ${Titel || 'Kein Titel'}
FRAGE: ${cleanedQuestion}
ANTWORT: ${cleanedAnswer}
DATUM: ${Datum || 'Kein Datum'}
ANTWORTGEBER: ${NameAntwortgeber || 'Unbekannt'}
    `.trim();
    
    // Create searchable text for embedding
    const searchableText = createSearchableText(record);
    
    // Prepare document for batch insertion
    batch.push({
      text: displayText,
      searchText: searchableText,
      metadata: {
        type: "faq",
        kategorie: Kategorie || '',
        titel: Titel || '',
        frage: cleanedQuestion,
        datum: Datum || '',
        antwort: cleanedAnswer,
        nameAntwortgeber: NameAntwortgeber || '',
        // Add languageHint for better search matching
        languageHint: /[äöüÄÖÜß]/.test(cleanedQuestion) ? 'de' : 'en'
      }
    });
    
    // Process batch when it reaches the defined size
    if (batch.length >= batchSize) {
      await processBatch(batch, collection);
      processedCount += batch.length;
      console.log(`📊 Progress: ${processedCount} records processed (${successCount} successful, ${errorCount} failed)`);
      batch = [];
    }
  }
  
  // Process any remaining items
  if (batch.length > 0) {
    await processBatch(batch, collection);
    processedCount += batch.length;
  }
  
  console.log("✅ CSV processing complete:");
  console.log(`   - Total processed: ${processedCount}`);
  console.log(`   - Successfully inserted: ${successCount}`);
  console.log(`   - Failed: ${errorCount}`);
};

// Function to ensure collection exists
async function ensureCollectionExists(collectionName) {
  try {
    console.log(`🔍 Checking if collection '${collectionName}' exists...`);
    
    // List all collections to check if our collection exists
    const collections = await db.listCollections();
    const collectionExists = collections.some(c => c.name === collectionName);
    
    if (!collectionExists) {
      console.log(`⚠️ Collection '${collectionName}' does not exist. Creating now...`);
      
      // Create vector collection with proper index
      await db.createCollection(collectionName, {
        vector: {
          dimension: 1536,  // Dimension for text-embedding-3-small
          metric: "cosine"
        }
      });
      
      console.log(`✅ Collection '${collectionName}' created successfully.`);
    } else {
      console.log(`✅ Collection '${collectionName}' already exists.`);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Error creating/checking collection: ${error.message}`);
    throw error;
  }
}

// Helper function to process a batch of records
async function processBatch(batch, collection) {
  // Generate embeddings for all items in the batch
  const embeddings = await Promise.all(
    batch.map(async (item) => {
      try {
        const response = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: item.searchText, // Use the enhanced search text for embedding
          encoding_format: "float"
        });
        return {
          vector: response.data[0].embedding,
          item: item
        };
      } catch (error) {
        console.error(`❌ Embedding error for "${item.metadata.titel?.slice(0, 40)}...": ${error.message}`);
        return null;
      }
    })
  );
  
  // Filter out failed embeddings
  const validEmbeddings = embeddings.filter(e => e !== null);
  
  // Insert documents with their embeddings
  for (const {vector, item} of validEmbeddings) {
    try {
      // Insert the FAQ entry with its vector embedding
      await collection.insertOne({
        $vector: vector,
        text: item.text,
        metadata: item.metadata
      });
      console.log(`✔️ Inserted: ${item.metadata.titel?.slice(0, 40)}... (${item.metadata.kategorie})`);
      successCount++;
    } catch (error) {
      console.error(`❌ Database error for "${item.metadata.titel?.slice(0, 40)}...": ${error.message}`);
      errorCount++;
    }
  }
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('💥 Unhandled Promise Rejection:', error);
  process.exit(1);
});

// Run the loader
console.log("🔍 Starting FAQ data loader...");
loadCSVData()
  .then(() => console.log("✅ CSV loader finished successfully"))
  .catch((error) => {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  });