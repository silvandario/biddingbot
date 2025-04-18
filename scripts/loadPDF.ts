import { DataAPIClient } from "@datastax/astra-db-ts"
import OpenAI from "openai"
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter"
import "dotenv/config"
import fs from 'fs'
import path from 'path'
import pdfParse from 'pdf-parse' 

type SimilarityMetric = "dot_product" | "cosine" | "euclidean"
const { NEXT_ASTRA_DB_NAMESPACE, NEXT_ASTRA_DB_COLLECTION, NEXT_ASTRA_DB_API_ENDPOINT, NEXT_ASTRA_DB_APPLICATION_TOKEN, NEXT_PUBLIC_OPENAI_API_KEY } = process.env
const openai = new OpenAI({ apiKey: NEXT_PUBLIC_OPENAI_API_KEY})
const client = new DataAPIClient(NEXT_ASTRA_DB_APPLICATION_TOKEN)
const db = client.db(NEXT_ASTRA_DB_API_ENDPOINT, {keyspace: NEXT_ASTRA_DB_NAMESPACE})

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 512,
  chunkOverlap: 100
})

// Define a function to parse a single PDF
const parsePdf = async (filePath) => {
  try {
    const dataBuffer = await fs.promises.readFile(filePath)
    const pdfData = await pdfParse(dataBuffer)
    return pdfData.text
  } catch (error) {
    console.error(`Error parsing PDF ${filePath}:`, error)
    return ''
  }
}

const createCollection = async (similarityMetric: SimilarityMetric = "dot_product") => {
  const res = await db.createCollection(NEXT_ASTRA_DB_COLLECTION, {
    vector: {
      dimension: 1536,
      metric: similarityMetric,
    }
  })
  console.log(res)
}

const loadSampleData = async () => {
  const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION)
  
  // Parse PDFs from each master's program folder
  const mastersFolders = ['macfin', 'MBI', 'MGM', 'MiMM']
  const basePath = "/Users/silvandarioprivat/Desktop/courses"
  
  for (const program of mastersFolders) {
    const programPath = path.join(basePath, program)
    
    try {
      // Check if the directory exists
      await fs.promises.access(programPath)
      
      // Get all PDF files in this program folder
      const files = await fs.promises.readdir(programPath)
      const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'))
      
      for (const pdfFile of pdfFiles) {
        const filePath = path.join(programPath, pdfFile)
        console.log(`Processing ${filePath}...`)
        
        try {
          // Parse the PDF content
          const content = await parsePdf(filePath)
          
          // Skip empty content
          if (!content) continue
          
          // Split content into chunks
          const chunks = await splitter.splitText(content)
          
          // Process each chunk
          for (const chunk of chunks) {
            const embedding = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: chunk,
              encoding_format: "float"
            })
            
            const vector = embedding.data[0].embedding
            
            // Store chunk with metadata about the source
            const res = await collection.insertOne({
              $vector: vector,
              text: chunk,
              metadata: {
                source: pdfFile,
                program: program,
                path: filePath
              }
            })
            
            console.log(`Inserted chunk from ${pdfFile} (${program})`)
          }
        } catch (error) {
          console.error(`Error processing ${pdfFile}:`, error)
        }
      }
    } catch (error) {
      console.error(`Error accessing directory ${programPath}:`, error)
    }
  }
}

// Function to check if directories exist and create them if needed
const checkDirectories = async () => {
  const basePath = "/Users/adam/Desktop/courses"
  const mastersFolders = ['macfin', 'MBI', 'MGM', 'MiMM']
  
  try {
    // Check if base directory exists
    try {
      await fs.promises.access(basePath)
    } catch {
      await fs.promises.mkdir(basePath)
      console.log(`Created base directory: ${basePath}`)
    }
    
    // Check/create each masters folder
    for (const folder of mastersFolders) {
      const folderPath = path.join(basePath, folder)
      try {
        await fs.promises.access(folderPath)
        console.log(`Directory exists: ${folderPath}`)
      } catch {
        await fs.promises.mkdir(folderPath)
        console.log(`Created directory: ${folderPath}`)
      }
    }
  } catch (error) {
    console.error("Error setting up directories:", error)
  }
}

createCollection().then(() => loadSampleData()).catch(console.error)