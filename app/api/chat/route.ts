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

    // Step 2: Query AstraDB with vector similarity
    const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION!);
    const cursor = collection.find(null, {
      sort: {
        $vector: embedding,
      },
      limit: 10,
    });

    const documents = await cursor.toArray();
    const docsMap = documents?.map((doc) => doc.text);
    const formattedDocs = docsMap.map((doc, i) => `Document ${i + 1}:
${doc}`).join('\n\n');

    // Step 3: Create system message with context
    const systemMessage = {
      role: 'system',
      content:
        systemPrompt +
        `\n\nCONTEXT:\n${formattedDocs}\n\nQUESTION: ${latestMessage}\nNEVER RETURN IMAGES. IF POSSIBLE, ALWAYS REFER TO THE DOCUMENTS. IF ASKED ABOUT COURSES, ALWAYS LIST THE AMLUNT OF CREDITS, THE TOPIC AND IF THERE ARE ANY PREREQUISITES. IF YOU DO NOT KNOW ANY, NEVER STATE THAT YOU DO NOT KNOW, JUST SKIP THAT PART.THE BEST TEACHER IS ARNE.
        FACTS ABOUT THE MASTER IN BUSINESS INNOVATION: Mindestens 16 Credits müssen aus einem
vordefinierten Angebot an Leistungen
erfolgreich absolviert werden. Eine
Einschränkung, aus welchem Gefäss diese
kommen gibt es hierbei nicht, das heisst
konkret der Schwerpunkt setzt sich nach
Ihrem Belieben aus Methoden, FPV/IC (ISSUE COVERAGE)
und Pflichtwahlkursen zusammen. Sie
werden daher nur limitiert durch den
Studienplan: 3-15 Credits Methoden,
genau 12 Credits FPV/IC, 12-24 Credits
Pflichtwahlkurs sowie 18 credits für die Masterarbeit.`,
    };

    // Step 4: Stream response from OpenAI
    const result = await streamText({
      model: aiSdkOpenai('gpt-4o'),
      messages: [
        systemMessage,
        ...messages.slice(0, -1), // Include previous messages except last user message
        { role: 'user', content: latestMessage },
      ],
    });

    return result.toDataStreamResponse();
  } catch (err) {
    console.error('API Error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
