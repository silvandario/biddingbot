import "dotenv/config"
import fs from "fs"
import path from "path"
import { parse } from "csv-parse"
import { DataAPIClient } from "@datastax/astra-db-ts"
import OpenAI from "openai"

const {
  NEXT_ASTRA_DB_API_ENDPOINT,
  NEXT_ASTRA_DB_APPLICATION_TOKEN,
  NEXT_ASTRA_DB_NAMESPACE,
  NEXT_ASTRA_DB_COLLECTION,
  NEXT_PUBLIC_OPENAI_API_KEY
} = process.env

const openai = new OpenAI({ apiKey: NEXT_PUBLIC_OPENAI_API_KEY })
const client = new DataAPIClient(NEXT_ASTRA_DB_APPLICATION_TOKEN)
const db = client.db(NEXT_ASTRA_DB_API_ENDPOINT, { keyspace: NEXT_ASTRA_DB_NAMESPACE })

const csvFilePath = path.resolve(__dirname, "../data/faq.csv")

const loadCSVData = async () => {
  const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION)

  const parser = fs
    .createReadStream(csvFilePath)
    .pipe(parse({
      columns: true,
      skip_empty_lines: true
    }))

  for await (const record of parser) {
    const { Kategorie, Titel, Frage, Antwort } = record

    if (!Frage || !Antwort) continue

    const combinedText = `
Kategorie: ${Kategorie}
Titel: ${Titel}
Frage: ${Frage}
Antwort: ${Antwort}
    `.trim()

    try {
      const embedding = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: combinedText,
        encoding_format: "float"
      })

      const vector = embedding.data[0].embedding

      await collection.insertOne({
        $vector: vector,
        text: combinedText,
        metadata: {
          kategorie: Kategorie,
          titel: Titel
        }
      })

      console.log(`✔ Eingefügt: ${Titel?.slice(0, 60)}...`)
    } catch (error) {
      console.error("❌ Fehler beim Einfügen:", error)
    }
  }

  console.log("✅ CSV-Verarbeitung abgeschlossen.")
}

loadCSVData().catch(console.error)