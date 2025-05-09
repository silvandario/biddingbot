// thesisLoader.ts
import { DataAPIClient } from "@datastax/astra-db-ts";
import OpenAI from "openai";
import xlsx from "xlsx";
import path from "path";
import fs from "fs";
import "dotenv/config";

const {
  NEXT_ASTRA_DB_NAMESPACE,
  NEXT_ASTRA_DB_COLLECTION,
  NEXT_ASTRA_DB_API_ENDPOINT,
  NEXT_ASTRA_DB_APPLICATION_TOKEN,
  NEXT_PUBLIC_OPENAI_API_KEY,
} = process.env;

const openai = new OpenAI({ apiKey: NEXT_PUBLIC_OPENAI_API_KEY });
const client = new DataAPIClient(NEXT_ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(NEXT_ASTRA_DB_API_ENDPOINT!, {
  keyspace: NEXT_ASTRA_DB_NAMESPACE!,
});

const excelFilePath = path.join("data", "private_equity_theses_BiddingBro.xlsx");

const loadThesesFromExcel = async () => {
  const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION!);

  const workbook = xlsx.readFile(excelFilePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: string[][] = xlsx.utils.sheet_to_json(sheet, { header: 1 }) as string[][];

  for (const row of rows) {
    if (row.length < 4) continue; // Skip malformed rows

    const [titleThesis, student, year, supervisor] = row;
    const text = `Title: ${titleThesis}\nStudent: ${student}\nYear: ${year}\nSupervisor: ${supervisor}`;

    try {
      const embeddingRes = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
        encoding_format: "float",
      });

      await collection.insertOne({
        $vector: embeddingRes.data[0].embedding,
        text,
        metadata: {
          titleThesis,
          student,
          year,
          supervisor,
          type: "thesis",
          source: "private_equity_theses_BiddingBro.xlsx",
        },
      });

      console.log(`✅ Inserted thesis: ${titleThesis}`);
    } catch (err) {
      console.error(`❌ Error inserting thesis: ${titleThesis}`, err);
    }
  }
};

const main = async () => {
  try {
    await loadThesesFromExcel();
    console.log("🎓 Thesis loading completed successfully!");
  } catch (error) {
    console.error("❌ Error in thesis loader:", error);
  }
};

main();
