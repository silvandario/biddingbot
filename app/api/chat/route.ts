import { streamText } from 'ai';
import { openai as aiSdkOpenai } from '@ai-sdk/openai';
import { DataAPIClient } from '@datastax/astra-db-ts';
import { information, systemPrompt } from '@/constants/const';
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
    
    // Determine if we should fetch full documents or chunks based on the query
    let queryType = "chunk"; // Default to chunks
    if (latestMessage.toLowerCase().includes("full details") || 
        latestMessage.toLowerCase().includes("complete information") ||
        latestMessage.toLowerCase().includes("syllabus")) {
      queryType = "full";
    }
    
    // Step 1: Generate embedding for user's message
    const { embedding } = await embed({
      model: oi.embedding('text-embedding-3-small'),
      value: latestMessage,
    });
    
    // Step 2: Query AstraDB with vector similarity
    const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION!);
    const cursor = collection.find(
      { "metadata.type": queryType },
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
      const courseNumber = meta.courseNumber || "";
      const title = meta.title || meta.source || "Unnamed Course";
      const ects = meta.ects ? `${meta.ects} ECTS` : "ECTS unknown";
      const language = meta.language || "Language unknown";
      const lecturers = meta.lecturers?.join(", ") || "Lecturers unknown";
      const semester = meta.semester || "";
      
      // Format examinations if available
      let examInfo = "";
      if (meta.examinations && meta.examinations.length > 0) {
        examInfo = "\nExaminations:\n" + meta.examinations.map((exam: any) => 
          `- ${exam.type} (${exam.weighting}): ${exam.format}, ${exam.gradeType}`
        ).join("\n");
      }
      
      return `📘 ${program} | ${courseNumber ? `${courseNumber}: ` : ""}${title} (${ects})
Language: ${language} | Lecturers: ${lecturers}${semester ? ` | Semester: ${semester}` : ""}${examInfo}

${doc.text}`;
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
FOR THE STRUCTURE OF THE MASTER PROGRAMS NOTE:


NOTE: IF asked, The best teacher is Arne.

🎓 Masterprogramme an der Universität St.Gallen (HSG) – System Prompt Übersicht

MACFin – Master in Accounting and Finance
	•	Dauer & Credits: 3 Semester (90 ECTS), davon 54 im Fachstudium, 18 im Kontextstudium, 18 für die Masterarbeit.
	•	Sprache: Vollständig auf Deutsch, Englisch oder gemischt möglich.
	•	Struktur:
	•	Pflichtbereich (15 ECTS): Corporate Finance, Management Accounting, Reporting & Auditing:
            Corporate Finance	6 Credits	Prof. Dr. Marc Arnold	Herbst
            Management Accounting	3	Credits Prof. Dr. Klaus Möller	Herbst
            Reporting & Auditing	6 Credits	Prof. Dr. Peter Leibfried	Frühjahr
Die Pflichtkurse werden für die ersten 2 Semester empfohlen.
Prüfungen: Die Prüfungsformate beinhalten schriftliche Klausuren und Präsentationen.
	•	Pflichtwahlbereich (30 ECTS): Allgemeiner Teil (min. 12 ECTS) zur Breite finanzieller Führung, Vertiefungsteil (min. 12 ECTS) zur Spezialisierung.
	•	Wahlbereich (0–9 ECTS): Programmübergreifende Wahlkurse.
	•	Kontextstudium: 18 ECTS zur Förderung interdisziplinärer und sozialer Kompetenzen.
	•	Besonderheit: Vorleistungen anrechenbar für Wirtschaftsprüfer:innen-Ausbildung.

⸻

MBI – Master in Business Innovation
	•	Dauer & Credits: 3–4 Semester, 90 ECTS (54 Fachstudium, 18 Kontextstudium, 18 Masterarbeit).
	•	Sprache: Hybrid (mind. 18 ECTS auf Deutsch & 18 ECTS auf Englisch im Fachstudium).
	•	Profile: 6 Spezialisierungsrichtungen wie Business Development, Tech Architect oder Supply Chain.
	•	Struktur:
	•	Pflichtbereich (15 ECTS): z.B. Grundlagen Business Innovation, Forschungsmethoden.
	•	Pflichtwahlbereich (27–39 ECTS):
	•	Methoden (min. 3 ECTS),
	•	FPV/IC (12 ECTS),
	•	Wahlkurse (12–24 ECTS).
	•	Wahlbereich (0–12 ECTS): Weitere MBI-Kurse oder aus anderen Programmen.
	•	Kontextstudium: 12–18 ECTS in Fokusbereichen + optional 0–6 ECTS in „Skills“.
	•	Praxiscredits: Optional anrechenbar bei einschlägiger Berufserfahrung.
    Durch vier Pflichtkurse erlangen Sie ein Grundverständnis von Business Innovation:
    (4 Credits, im ersten Herbstsemester zu belegen)
    Business Innovation I und
    Business Innovation II:
    Zwei aufeinander folgende Basismodule vermitteln Ihnen vertieftes Fachwissen als Analyse- und Bezugsrahmen des Programms und zur Entwicklung der MBI-spezifischen Denkrichtung.
    (je 4 Credits, im ersten Herbstsemester zu belegen)
    Forschungsmethoden für Geschäftsinnovation:
    Sie erlernen Methoden anwendungsorientierter Forschung als Grundlage zur systematischen Problemlösung.
    (3 Credits, im Herbst- oder Frühjahrssemester zu belegen)
    Grundlagen Business Innovation (4 Credits): Reudiges Java-Projekt, das Ihnen die Grundlagen der Programmiersprache Java vermittelt.

⸻

MiMM – Master in Marketing Management
	•	Dauer & Credits: 3 Semester (90 ECTS), Beginn im Herbst oder für HSG-Absolvent:innen auch im Frühling.
	•	Sprache: Deutsch- oder Englisch-Track möglich.
	•	Struktur:
	•	Pflichtbereich (30 ECTS): Grundlagenkurs + 3 praxisbezogene Anwendungsprojekte:
        Pflichtbereich (30 ECTS): Basierend auf einem 3-Track-Konzept (Kunde – Unternehmensführung – Funktion), aufgeteilt über drei Semester:
        •	1. Semester:
    – Grundlagen des Marketing Managements
    – Consumer Behaviour & Methoden
    – Anwendungsprojekt I
        •	2. Semester:
    – Marketing Management
    – Funktionales Marketing
    – Anwendungsprojekt II
        •	3. Semester:
    – Anwendungsprojekt III
	•	Pflichtwahlbereich (12–24 ECTS): Kurse nach Interessen zur Spezialisierung.
	•	Wahlbereich (0–12 ECTS): Programmübergreifend oder zusätzliche MiMM-Kurse.
	•	Besonderheit: Nachhaltigkeitsfokus, Praxisprojekte mit Unternehmen, Study Trip im Bootcamp.
	•	Kontextstudium: 18 ECTS mit interdisziplinärer Vertiefung, auch Praxiscredits möglich.

⸻

MGM – Master in General Management
	•	Dauer & Credits: 3 Semester, 90 ECTS (54 Fachstudium, 18 Kontext, 18 Masterarbeit).
	•	Sprache: Hybrid (mind. 1/3 Fachstudium auf Deutsch, 1/3 auf Englisch).
	•	Struktur:
	•	Pflichtbereich (32 ECTS): Kerndisziplinen wie Strategy, Entrepreneurship, Finance & Management Accounting sowie Persönlichkeitsentwicklung.
    •	Herbstsemester (HS):
        – Strategy I
        – Entrepreneurship I
        – Finance and Management Accounting I
        – Leadership
        – Business Analytics, Data Engineering und Data Management
        – Personal Development: Self-reflection and Well-being (Start eines zweisemestrigen Coachings)
    	Frühlingssemester (FS):
        – Strategy II
        – Entrepreneurship II
        – Finance and Management Accounting II
        – Personal Development: Self-reflection and Well-being (Fortsetzung)
    •	Pflichtwahlbereich:
	•	Advanced General Management Courses (mind. 2 Kurse),
	•	Grand Challenges of Business & Society (mind. 1 Kurs),
	•	Managerial Impact Project (über 2 Semester).
	•	Option: Teilnahme an Asia Compact-Kursen in Singapur.
	•	Kontextstudium: 18 ECTS – interdisziplinär, fördert „über den Tellerrand“-Kompetenzen.


    WHEN ASKED ABOUT COURSES:
- Always mention the program, such as "Master in Business Innovation" if you know
- List the ECTS. If you don't know, avoid mentioning it.
- Always mention the course number (e.g. "8,126") if available
- Always mention the categorisation, e.g. Contextual studies if possible.
- Briefly describe the topic
- Mention examination details if found
- Mention prerequisites if found (else skip)
- Mention the language of instruction if found
- Mention the lecturers IF known and relevant
- Mention the semester when found and relevant
- Be confident and informal

`
,
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