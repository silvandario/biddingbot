import { DataAPIClient } from "@datastax/astra-db-ts";
import OpenAI from "openai";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import "dotenv/config";

// Verbesserte Chunk-Größe für besseren Kontext
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1500,  // Erhöht von 512
  chunkOverlap: 250, // Erhöht von 100
});

const {
  NEXT_ASTRA_DB_NAMESPACE,
  NEXT_ASTRA_DB_COLLECTION,
  NEXT_ASTRA_DB_API_ENDPOINT,
  NEXT_ASTRA_DB_APPLICATION_TOKEN,
  NEXT_PUBLIC_OPENAI_API_KEY,
} = process.env;

const openai = new OpenAI({ apiKey: NEXT_PUBLIC_OPENAI_API_KEY });
const client = new DataAPIClient(NEXT_ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(NEXT_ASTRA_DB_API_ENDPOINT, {
  keyspace: NEXT_ASTRA_DB_NAMESPACE,
});

/**
 * Extrahiert den Kursnamen aus dem PDF-Inhalt
 */
const extractCourseName = (content: string): string => {
  const courseNameMatch = content.match(/\d+,\d+:?\s+([^]+?)(?=\nECTS credits|\n\n)/i);
  if (courseNameMatch && courseNameMatch[1]) {
    return courseNameMatch[1].trim();
  }
  
  const titleMatch = content.match(/(?:Course|Fact sheet)[\s\S]*?\n([^\n]+)/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].trim();
  }
  
  return "";
};

/**
 * Extrahiert die ECTS-Credits aus dem PDF-Inhalt
 */
const extractECTSCredits = (content: string): number | null => {
  const creditsMatch = content.match(/ECTS credits:\s*(\d+(?:\.\d+)?)/i);
  return creditsMatch ? parseFloat(creditsMatch[1]) : null;
};

/**
 * Extrahiert das Semester aus dem PDF-Inhalt
 */
const extractSemester = (content: string): string | null => {
  const semesterMatch = content.match(/(?:valid for|version:)[\s\S]*?(Spring|Fall|Autumn)\s+Semester\s+(\d{4})/i);
  if (semesterMatch) {
    return `${semesterMatch[1]} ${semesterMatch[2]}`;
  }
  return null;
};

/**
 * Entfernt die letzte Seite aus dem PDF und gibt den restlichen Text zurück
 */
const parsePdfWithoutLastPage = async (filePath: string): Promise<string> => {
  try {
    const dataBuffer = await fs.promises.readFile(filePath);
    const pdf = await pdfParse(dataBuffer);
    
    // Methode 1: Bei Formfeed-Zeichen aufteilen (zuverlässiger)
    const allPages = pdf.text.split("\f");
    const contentWithoutLast = allPages.slice(0, -1).join("\f");
    
    // Falls keine Formfeed-Zeichen gefunden wurden, versuche alternative Methode
    if (allPages.length <= 1) {
      // Methode 2: Versuche, nach Seitenzahlen zu splitten
      const pagePattern = /Page \d+ \/ \d+|Fact sheet version: \d+\.\d+ as of \d+\/\d+\/\d{4}/g;
      const matches = [...pdf.text.matchAll(pagePattern)];
      
      if (matches.length > 1) {
        const lastPageStart = matches[matches.length - 1].index;
        return pdf.text.substring(0, lastPageStart).trim();
      }
    }
    
    return contentWithoutLast.trim();
  } catch (error) {
    console.error(`Error parsing PDF ${filePath}:`, error);
    return "";
  }
};

/**
 * Erstellt eine Collection in AstraDB
 */
const createCollection = async () => {
  try {
    // Prüfen, ob Collection bereits existiert
    try {
      await db.collection(NEXT_ASTRA_DB_COLLECTION);
      console.log(`Collection ${NEXT_ASTRA_DB_COLLECTION} exists already.`);
      return;
    } catch (e) {
      // Collection existiert nicht, erstelle sie
      await db.createCollection(NEXT_ASTRA_DB_COLLECTION, {
        vector: {
          dimension: 1536,
          metric: "cosine", // Geändert zu cosine für semantisch bessere Ergebnisse
        },
      });
      console.log(`Collection created: ${NEXT_ASTRA_DB_COLLECTION}`);
    }
  } catch (error) {
    console.error("Error creating collection:", error);
    throw error;
  }
};

/**
 * Lädt PDF-Daten aus allen Programm-Ordnern
 */
const loadSampleData = async () => {
  const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION);
  const basePath = "/Users/silvandarioprivat/Desktop/courses";
  const mastersFolders = ["macfin", "MBI", "MGM", "MiMM"];
  
  for (const program of mastersFolders) {
    const programPath = path.join(basePath, program);
    
    try {
      const files = await fs.promises.readdir(programPath);
      const pdfFiles = files.filter((f) => f.endsWith(".pdf"));
      
      console.log(`Found ${pdfFiles.length} PDF files in ${program}`);
      
      for (const pdfFile of pdfFiles) {
        const filePath = path.join(programPath, pdfFile);
        console.log(`Processing ${filePath}...`);
        
        try {
          const content = await parsePdfWithoutLastPage(filePath);
          if (!content) {
            console.log(`Skipping empty content: ${filePath}`);
            continue;
          }
          
          // Metadaten extrahieren
          const courseName = extractCourseName(content);
          const ectsCredits = extractECTSCredits(content);
          const semester = extractSemester(content);
          
          console.log(`Extracted metadata: ${courseName} (${ectsCredits} ECTS, ${semester})`);
          
          // Index full document
          const fullEmbedding = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: content,
            encoding_format: "float",
          });
          
          await collection.insertOne({
            $vector: fullEmbedding.data[0].embedding,
            text: content,
            metadata: {
              source: pdfFile,
              program,
              path: filePath,
              type: "full",
              courseName,
              ectsCredits,
              semester,
            },
          });
          
          // Index chunks
          const chunks = await splitter.splitText(content);
          
          console.log(`Splitting into ${chunks.length} chunks...`);
          
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const embedding = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: chunk,
              encoding_format: "float",
            });
            
            await collection.insertOne({
              $vector: embedding.data[0].embedding,
              text: chunk,
              metadata: {
                source: pdfFile,
                program,
                path: filePath,
                type: "chunk",
                courseName,
                ectsCredits,
                semester,
                chunkIndex: i,
                totalChunks: chunks.length,
              },
            });
          }
          
          console.log(`✅ Indexed: ${pdfFile} - ${chunks.length} chunks`);
        } catch (err) {
          console.error(`❌ Error processing ${pdfFile}:`, err);
        }
      }
    } catch (error) {
      console.error(`Error accessing directory ${programPath}:`, error);
    }
  }
};

/**
 * Hauptfunktion zum Ausführen des Skripts
 */
const main = async () => {
  try {
    await createCollection();
    await loadSampleData();
    console.log("✅ Data loading completed successfully!");
  } catch (error) {
    console.error("❌ Error in main execution:", error);
  }
};