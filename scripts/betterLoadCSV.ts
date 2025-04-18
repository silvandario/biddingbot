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
const csvFilePath = path.resolve(__dirname, "../data/faq.csv");

// Track statistics
let successCount = 0;
let errorCount = 0;
let duplicateCount = 0;

// Function to clean and normalize text
const cleanText = (text) => {
  if (!text) return "";
  return text.trim()
    .replace(/\s+/g, ' ')    // Replace multiple spaces with a single space
    .replace(/\n\s*\n/g, '\n'); // Replace multiple newlines with a single newline
};

// Function to create additional search text for better embedding
const createSearchableText = (record) => {
  const { Kategorie, Titel, Frage, Antwort } = record;
  
  // Create variations of the question to improve semantic search
  const questionVariations = [
    Frage,
    // Create variations without question marks
    Frage.replace(/\?/g, ''),
    // Turn questions into statements
    Frage.replace(/^(Wie|Was|Wo|Wann|Warum|Wer|Welche|Welcher|Welches|Kann|Ist|Sind|Hat|Haben|Darf|Müssen|Soll|Können)/i, '')
      .replace(/\?/g, '.')
  ].filter(Boolean);
  
  // Combine all text for enriched embedding
  return `
    KATEGORIE: ${Kategorie || ''}
    TITEL: ${Titel || ''}
    FRAGE: ${Frage || ''}
    FRAGE VARIATIONEN: ${questionVariations.join(' | ')}
    ANTWORT: ${Antwort || ''}
    SUCHBEGRIFFE: ${[Kategorie, Titel, Frage].filter(Boolean).join(' ')}
  `.trim();
};

// Function to calculate chunk ID for deduplication
const calculateChunkId = (text) => {
  return Buffer.from(text.substring(0, 100)).toString('base64');
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
  const processedIds = new Set();
  
  console.log("🚀 Starting CSV processing...");
  
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
    
    // Create unique ID to avoid duplicates
    const chunkId = calculateChunkId(cleanedQuestion + cleanedAnswer);
    if (processedIds.has(chunkId)) {
      console.log(`🔄 Skipping duplicate: ${Titel?.slice(0, 40)}...`);
      duplicateCount++;
      continue;
    }
    processedIds.add(chunkId);
    
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
        chunkId: chunkId
      }
    });
    
    // Process batch when it reaches the defined size
    if (batch.length >= batchSize) {
      await processBatch(batch, collection);
      processedCount += batch.length;
      console.log(`📊 Progress: ${processedCount} records processed (${successCount} successful, ${errorCount} failed, ${duplicateCount} duplicates)`);
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
  console.log(`   - Duplicates skipped: ${duplicateCount}`);
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
      // Check if document with same chunkId already exists
      const existing = await collection.findOne({ "metadata.chunkId": item.metadata.chunkId });
      
      if (existing) {
        // Update existing document
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              $vector: vector,
              text: item.text,
              metadata: item.metadata
            }
          }
        );
        console.log(`🔄 Updated: ${item.metadata.titel?.slice(0, 40)}... (${item.metadata.kategorie})`);
      } else {
        // Insert new document
        await collection.insertOne({
          $vector: vector,
          text: item.text,
          metadata: item.metadata
        });
        console.log(`✔️ Inserted: ${item.metadata.titel?.slice(0, 40)}... (${item.metadata.kategorie})`);
      }
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