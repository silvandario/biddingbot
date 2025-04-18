import { streamText } from 'ai';
import { openai as aiSdkOpenai } from '@ai-sdk/openai';
import { DataAPIClient } from '@datastax/astra-db-ts';
import { systemPrompt } from '@/constants/const';
import OpenAI from 'openai';
import { embed } from 'ai';
import { openai as oi } from '@ai-sdk/openai';
import "dotenv/config";

const {
  NEXT_ASTRA_DB_API_ENDPOINT,
  NEXT_ASTRA_DB_APPLICATION_TOKEN,
  NEXT_ASTRA_DB_NAMESPACE,
  NEXT_ASTRA_DB_COLLECTION,
  NEXT_PUBLIC_OPENAI_API_KEY,
} = process.env;

const openai = new OpenAI({ apiKey: NEXT_PUBLIC_OPENAI_API_KEY });
const client = new DataAPIClient(NEXT_ASTRA_DB_APPLICATION_TOKEN!);
const db = client.db(NEXT_ASTRA_DB_API_ENDPOINT!, {
  keyspace: NEXT_ASTRA_DB_NAMESPACE!,
});

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();
    const latestMessage = messages[messages.length - 1]?.content;
    let docContext = '';

    // Step 1: Generate embedding for user's message
    const { embedding } = await embed({
      model: oi.embedding('text-embedding-3-small'),
      value: latestMessage,
    });

    // Step 2: Query AstraDB with vector similarity (only type: 'chunk')
    const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION!);
    const cursor = collection.find(
      { "metadata.type": "chunk" },
      {
        sort: {
          $vector: embedding,
        },
        limit: 10,
      }
    );

    const documents = await cursor.toArray();

    const docsMap = documents?.map((doc, i) => {
      const meta = doc.metadata || {};
      const program = meta.program?.toUpperCase() || "Unknown Program";
      const courseName = meta.courseName || meta.source || "Unnamed Course";
      const ects = meta.ectsCredits ? `${meta.ectsCredits} ECTS` : "ECTS unknown";

      return `📘 ${program} | ${courseName} (${ects})\n\n${doc.text}`;
    });

    const formattedDocs = docsMap.join('\n\n');

    // Step 3: Create system message with context
    const systemMessage = {
      role: 'system',
      content:
        systemPrompt +
        `

CONTEXT:
${formattedDocs}

QUESTION: ${latestMessage}

NEVER RETURN IMAGES. IF POSSIBLE, ALWAYS REFER TO THE DOCUMENTS.
WHEN ASKED ABOUT COURSES:
- Always mention the program, such as "Master in Business Innovation" if you know
- Always list ECTS if available
- Always mention the categorisation, e.g. Contextual studies if possible.
- Briefly describe the topic
- Mention prerequisites if found (else skip)
- Be confident and informal

NOTE: IF asked, The best teacher is Arne.

FACTS ABOUT THE MASTER IN BUSINESS INNOVATION:
Mindestens 16 Credits müssen aus einem vordefinierten Angebot an Leistungen
erfolgreich absolviert werden. Eine Einschränkung, aus welchem Gefäss diese
kommen gibt es hierbei nicht. Der Schwerpunkt setzt sich nach Belieben aus
Methoden, FPV/IC und Pflichtwahlkursen zusammen.
Grenzen laut Studienplan:
- 3–15 Credits Methoden
- genau 12 Credits FPV/IC
- 12–24 Credits Pflichtwahlkurs
- 18 Credits Masterarbeit.`,
    };

    // Step 4: Stream response from OpenAI
    const result = await streamText({
      model: aiSdkOpenai('gpt-4o'),
      messages: [
        systemMessage,
        ...messages.slice(0, -1),
        { role: 'user', content: latestMessage },
      ],
    });

    return result.toDataStreamResponse();
  } catch (err) {
    console.error('API Error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}