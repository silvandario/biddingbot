import { DataAPIClient } from "@datastax/astra-db-ts";
import OpenAI from "openai";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import "dotenv/config";

// Verbesserte Chunk-Größe für besseren Kontext
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,  // Reduce from 1500 to ensure staying under 8000 bytes
  chunkOverlap: 200,
  separators: ["\n\n", "\n", " ", ""], // Prioritized list of separators
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
 * Verbesserte Metadaten-Extraktion aus PDF-Inhalten
 * @param text - Der PDF-Textinhalt
 * @returns Strukturierte Metadaten
 */
function extractMetadata(text: string, sourceFile: string, debug = false) {
  const metadata: any = {
    sourcePDF: sourceFile
  };
  
  if (debug) {
    console.log("\n🔍 DEBUGGING PDF TEXT:");
    console.log("--------------------");
    console.log(text.substring(0, 1000) + "...");
    console.log("--------------------\n");
  }
  
  // Kursnummer & Titel
  const titleMatch = text.match(/(\d{1,3},\d{1,3}):\s*([^\n]+)/);
  if (titleMatch) {
    metadata.courseNumber = titleMatch[1];
    metadata.title = titleMatch[2].replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    console.log(`✅ Kurs: ${metadata.courseNumber} - ${metadata.title}`);
  } else {
    console.log("❌ Kursnummer/Titel nicht gefunden");
    
    // Alternative Methode für Kursnamen
    const altTitleMatch = text.match(/(\d+,\d+)[:\s]+([^]+?)(?=\nECTS|$)/);
    if (altTitleMatch) {
      metadata.courseNumber = altTitleMatch[1];
      metadata.title = altTitleMatch[2].replace(/([a-z])([A-Z])/g, '$1 $2').trim();
      console.log(`✅ Kurs (alt. Methode): ${metadata.courseNumber} - ${metadata.title}`);
    }
  }
  
  // ECTS Credits - Mehrere Formate unterstützen
  // Format 1: "ECTS credits: 6"
  let ectsMatch = text.match(/ECTS\s*credits:?\s*(\d+)/i);
  
  // Format 2: "ECTS-Credits: 6"
  if (!ectsMatch) {
    ectsMatch = text.match(/ECTS-Credits:?\s*(\d+)/i);
  }
  
  // Format 3: "ECTS: 6"
  if (!ectsMatch) {
    ectsMatch = text.match(/ECTS:?\s*(\d+)/i);
  }
  
  // Format 4: "6 ECTS"
  if (!ectsMatch) {
    ectsMatch = text.match(/(\d+)\s*ECTS/i);
  }
  
  // Weitere Varianten mit verschiedenen Trennzeichen
  if (!ectsMatch) {
    ectsMatch = text.match(/ECTS[\s:-]+(\d+)/i);
  }
  
  // Unterstützung für zusammengeschriebene Formate ohne Leerzeichen
  if (!ectsMatch) {
    ectsMatch = text.match(/ECTS[^0-9]*(\d+)/i);
  }
  
  if (ectsMatch) {
    metadata.ects = parseInt(ectsMatch[1], 10);
    console.log(`✅ ECTS: ${metadata.ects}`);
  } else {
    console.log("❌ ECTS nicht gefunden");
    
    // Letzte Chance: Suche nach Zahlen in der Nähe des ECTS-Begriffs
    const ectsProximityMatch = text.match(/ECTS[^0-9]{0,30}(\d+)/i);
    if (ectsProximityMatch) {
      metadata.ects = parseInt(ectsProximityMatch[1], 10);
      console.log(`✅ ECTS (Proximity-Methode): ${metadata.ects}`);
    }
  }
  
  // Sprache & Dozierende - mehrere Formate probieren
  extractLanguageAndLecturers(text, metadata);
  
  // Prüfungen extrahieren
  extractExaminations(text, metadata);
  
  // Semester extrahieren - erweiterte Patterns
  let semesterMatch = text.match(/(?:valid for|version:|gültig für|Version)[\s\S]*?(Spring|Fall|Autumn|Frühjahrssemester|Herbstsemester)\s+(?:Semester\s+)?(\d{4})/i);
  
  // Wenn nicht gefunden, suche nach deutschen Formaten
  if (!semesterMatch) {
    semesterMatch = text.match(/(Frühjahrssemester|Herbstsemester)\s*(\d{4})/i);
  }
  
  // Noch ein Versuch mit alternativen Formatierungen
  if (!semesterMatch) {
    semesterMatch = text.match(/(?:Semester|Term)[\s:]*([A-Za-z]+)[\s-]*(\d{4})/i);
  }
  
  if (semesterMatch) {
    // Deutsch nach Englisch übersetzen
    let semester = semesterMatch[1];
    if (semester.toLowerCase().includes("frühjahr")) {
      semester = "Spring";
    } else if (semester.toLowerCase().includes("herbst")) {
      semester = "Fall";
    }
    
    metadata.semester = `${semester} ${semesterMatch[2]}`;
    console.log(`✅ Semester: ${metadata.semester}`);
  } else {
    console.log("❌ Semester nicht gefunden");
    
    // Letzte Chance: Suche nach Jahren mit 4 Ziffern in der Nähe von Semester-ähnlichen Wörtern
    const yearMatch = text.match(/(?:semester|term|jahr)[^0-9]{0,30}(\d{4})/i);
    if (yearMatch) {
      // Wenn wir nur das Jahr haben, versuchen wir zu bestimmen, ob es Frühjahr oder Herbst ist
      const currentMonth = new Date().getMonth() + 1; // 1-12
      const semesterType = currentMonth >= 2 && currentMonth <= 8 ? "Spring" : "Fall";
      metadata.semester = `${semesterType} ${yearMatch[1]}`;
      console.log(`✅ Semester (Jahr-Methode): ${metadata.semester}`);
    }
  }
  
  return metadata;
}

/**
 * Extrahiert Prüfungsinformationen mit mehreren Strategien
 */
function extractExaminations(text: string, metadata: any) {
  // Initiale Prüfungsliste
  metadata.examinations = [];
  
  // Strategie 1: Englisches Standard-Format
  let examSections = [...text.matchAll(/decentral\s*-\s*([^,]+),\s*([^,]+),\s*([^(]+)\s+(individual|group)\s+grade\s*\((\d+%)\)/gi)];
  
  // Strategie 2: Deutsches Format
  if (examSections.length === 0) {
    examSections = [...text.matchAll(/dezentral\s*-\s*([^,]+),\s*([^,]+),\s*([^(]+)\s+(Individual|Gruppen)note\s*\((\d+%)\)/gi)];
  }
  
  // Strategie 3: Ohne Leerzeichen
  if (examSections.length === 0) {
    const examPattern = /(?:decentral|dezentral)-([^,]+),([^,]+),([^(]+)(individual|group|Individual|Gruppen)(?:note|grade)\((\d+%)\)/gi;
    examSections = [...text.matchAll(examPattern)];
  }
  
  if (examSections.length > 0) {
    metadata.examinations = examSections.map(e => ({
      type: e[1].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
      mode: e[2].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
      format: e[3].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
      gradeType: `${e[4].trim().toLowerCase()} grade`,
      weighting: e[5].trim()
    }));
    console.log(`✅ Prüfungen: ${examSections.length} gefunden`);
    metadata.examinations.forEach((exam: any, i: number) => {
      console.log(`   - Prüfung ${i+1}: ${exam.type} (${exam.weighting})`);
    });
  } else {
    console.log("❌ Prüfungen nicht im Standardformat gefunden");
    
    // Strategie 4: Manuelle Extraktion aus Zeilen mit Prüfungsinformationen
    const keywords = ['decentral', 'dezentral', 'prüfung', 'exam', 'test', 'note', 'grade'];
    const examLines = text.split('\n').filter(line => 
      keywords.some(keyword => line.toLowerCase().includes(keyword)) && 
      (line.includes('%') || line.includes('pass'))
    );
    
    if (examLines.length > 0) {
      console.log(`🔍 Alternative Prüfungszeilen gefunden: ${examLines.length}`);
      examLines.forEach((line, i) => {
        console.log(`   Zeile ${i+1}: "${line}"`);
        
        try {
          // Prüfe auf Prozentangaben
          const percentMatch = line.match(/\((\d+%)\)/i);
          if (percentMatch) {
            const weighting = percentMatch[1];
            
            // Suche nach Bewertungstyp (Einzel/Gruppe)
            let gradeType = "individual grade";  // Standard
            if (line.toLowerCase().includes("group") || line.toLowerCase().includes("gruppen")) {
              gradeType = "group grade";
            }
            
            // Extrahiere Prüfungstyp (erster Teil nach einem Bindestrich)
            let examType = "Exam";  // Standard
            const typeMatch = line.match(/(?:decentral|dezentral)\s*-\s*([^,]+)/i);
            if (typeMatch) {
              examType = typeMatch[1].trim();
            }
            
            // Versuche den Modus zu extrahieren
            let mode = "Unknown";
            const modeMatch = line.match(/(?:decentral|dezentral)\s*-\s*[^,]+,\s*([^,]+)/i);
            if (modeMatch) {
              mode = modeMatch[1].trim();
            }
            
            // Erstelle die Prüfung
            const exam = {
              type: examType.replace(/([a-z])([A-Z])/g, '$1 $2'),
              mode: mode.replace(/([a-z])([A-Z])/g, '$1 $2'),
              format: "Unknown",  // Wenn wir es nicht finden können
              gradeType: gradeType,
              weighting: weighting
            };
            
            metadata.examinations.push(exam);
            console.log(`✅ Prüfung extrahiert: ${exam.type} (${exam.weighting})`);
          }
        } catch (err) {
          console.log(`⚠️ Fehler beim Parsen der Prüfungszeile: ${err}`);
        }
      });
    }
  }
}

/**
 * Extrahiert Sprache und Dozierende mit mehreren Strategien
 */
function extractLanguageAndLecturers(text: string, metadata: any) {
  // Strategie 1: Standard-Format für englische PDFs
  let lectureLinePattern = /(\d{1,3},\d{1,3},\d{1,2}(?:\.00)?)[^-]+ -- ([^-]+) -- ([^-\n]+)/;
  let lectureLine = text.match(lectureLinePattern);
  
  // Strategie 2: Standard-Format für deutsche PDFs
  if (!lectureLine) {
    lectureLinePattern = /(\d{1,3},\d{1,3},\d{1,2}(?:\.00)?)[^-]+--([^-]+)--([^-\n]+)/;
    lectureLine = text.match(lectureLinePattern);
  }
  
  // Strategie 3: Deutsches Format mit anderen Trennzeichen
  if (!lectureLine) {
    lectureLinePattern = /(\d{1,3},\d{1,3}(?:,\d{1,2}(?:\.00)?)?)[^-]*--([^-]*)--([^-\n]*)/;
    lectureLine = text.match(lectureLinePattern);
  }
  
  if (lectureLine) {
    metadata.language = lectureLine[2].trim();
    metadata.lecturers = lectureLine[3].split(',').map((s: string) => 
      s.trim().replace(/([a-z])([A-Z])/g, '$1 $2')
    );
    console.log(`✅ Sprache: ${metadata.language}`);
    console.log(`✅ Dozierende: ${metadata.lecturers.join(', ')}`);
  } else {
    console.log("❌ Sprache/Dozierende nicht im Standardformat gefunden");
    
    // Strategie 4: Suche nach Zeilen mit '--' und bekannten Sprachen
    const possibleLecturerLines = text.split('\n').filter(line => 
      line.includes('--') && (
        line.toLowerCase().includes('english') || 
        line.toLowerCase().includes('deutsch') ||
        line.toLowerCase().includes('german') ||
        line.includes(metadata.courseNumber?.split(',')[0] || '')
      )
    );
    
    if (possibleLecturerLines.length > 0) {
      console.log(`🔍 Mögliche Dozierende-Zeilen gefunden: ${possibleLecturerLines.length}`);
      
      // Versuche die wahrscheinlichste Zeile zu extrahieren
      const bestCandidate = possibleLecturerLines[0];
      console.log(`🔍 Kandidatenzeile: "${bestCandidate}"`);
      
      const parts = bestCandidate.split('--');
      if (parts.length >= 3) {
        metadata.language = parts[1].trim();
        metadata.lecturers = parts[2].split(',').map((s: string) => 
          s.trim().replace(/([a-z])([A-Z])/g, '$1 $2')
        );
        console.log(`✅ Sprache (alt): ${metadata.language}`);
        console.log(`✅ Dozierende (alt): ${metadata.lecturers.join(', ')}`);
      }
    } else {
      console.log("❌ Keine alternativen Dozierende-Zeilen gefunden");
      
      // Strategie 5: Suche nach expliziten Sprachhinweisen
      if (!metadata.language) {
        if (text.toLowerCase().includes("sprache: deutsch") || 
            text.toLowerCase().includes("language: german")) {
          metadata.language = "Deutsch";
          console.log(`✅ Sprache (explicit): ${metadata.language}`);
        } else if (text.toLowerCase().includes("sprache: englisch") || 
                  text.toLowerCase().includes("language: english")) {
          metadata.language = "English";
          console.log(`✅ Sprache (explicit): ${metadata.language}`);
        }
      }
      
      // Strategie 6: Suche nach expliziten Dozenten-Hinweisen
      const dozentenMatch = text.match(/(?:Dozent(?:en)?|Lecturer[s]?)(?:\s*:\s*|\s+)([^\n\r]+)/i);
      if (dozentenMatch) {
        metadata.lecturers = [dozentenMatch[1].trim()];
        console.log(`✅ Dozierende (explicit): ${metadata.lecturers.join(', ')}`);
      }
    }
  }
  
  // Default-Werte für fehlende Informationen
  if (!metadata.language) {
    // Prüfe, ob mehr deutsche oder englische Wörter im Text vorkommen
    const germanKeywords = ['und', 'der', 'die', 'das', 'mit', 'für', 'prüfung', 'vorlesung'];
    const englishKeywords = ['and', 'the', 'with', 'for', 'exam', 'lecture'];
    
    let germanCount = 0;
    let englishCount = 0;
    
    germanKeywords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = text.match(regex);
      if (matches) germanCount += matches.length;
    });
    
    englishKeywords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = text.match(regex);
      if (matches) englishCount += matches.length;
    });
    
    metadata.language = germanCount > englishCount ? "Deutsch" : "English";
    console.log(`✅ Sprache (Wortanalyse): ${metadata.language}`);
  }
  
  if (!metadata.lecturers || metadata.lecturers.length === 0) {
    metadata.lecturers = ["Unknown"];
    console.log("⚠️ Keine Dozierenden gefunden, setze auf 'Unknown'");
  }
}

/**
 * Verbesserte PDF-Parser-Funktion mit besseren Text-Extraktionsoptionen
 */
async function parsePDF(filePath: string): Promise<any> {
  console.log(`\n📄 Verarbeite PDF: ${path.basename(filePath)}`);
  console.log(`📁 Pfad: ${filePath}`);
  
  try {
    // Prüfe, ob Datei existiert
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Datei nicht gefunden: ${filePath}`);
      return null;
    }
    
    const dataBuffer = fs.readFileSync(filePath);
    console.log(`📊 Dateigröße: ${(dataBuffer.length / 1024).toFixed(2)} KB`);
    
    // PDF parse mit verbesserten Optionen
    const options = {
      pagerender: function(pageData) {
        return pageData.getTextContent({
          normalizeWhitespace: true,
          disableCombineTextItems: false
        })
        .then(function(textContent) {
          let lastY, lastX, text = '';
          for (let item of textContent.items) {
            // Handle more complex page layouts with columns
            if (lastY !== item.transform[5] || (lastX && Math.abs(item.transform[4] - lastX) > 50)) {
              text += '\n';
            } else if (lastX && (item.transform[4] - lastX) > 2) {
              // Add space between words on same line if there's a gap
              text += ' ';
            }
            
            text += item.str;
            lastY = item.transform[5];
            lastX = item.transform[4] + item.width;
          }
          return text;
        });
      }
    };
    
    
    const data = await pdfParse(dataBuffer, options);
    console.log(`📄 PDF verarbeitet. Seiten: ${data.numpages}`);
    
    // Normalisiere Text, indem Leerzeichen zwischen Wörtern hinzugefügt werden
    const normalizedText = data.text.replace(/([a-z])([A-Z])/g, '$1 $2');
    
    // Extrahiere Metadaten mit ausführlicher Protokollierung
    const extracted = extractMetadata(normalizedText, path.basename(filePath), true);
    
    console.log("\n📝 Extrahierte Metadaten:");
    console.log(JSON.stringify(extracted, null, 2));
    return extracted;
  } catch (error) {
    console.error(`❌ Fehler beim Parsen der PDF: ${error}`);
    return null;
  }
}

/**
 * Erstellt eine Collection in AstraDB
 */
async function createCollection() {
  try {
    // Prüfen, ob Collection bereits existiert
    try {
      await db.collection(NEXT_ASTRA_DB_COLLECTION);
      console.log(`🗄️ Collection ${NEXT_ASTRA_DB_COLLECTION} existiert bereits.`);
      return;
    } catch (e) {
      // Collection existiert nicht, erstelle sie
      await db.createCollection(NEXT_ASTRA_DB_COLLECTION, {
        vector: {
          dimension: 1536,
          metric: "cosine", // Geändert zu cosine für semantisch bessere Ergebnisse
        },
      });
      console.log(`🆕 Collection erstellt: ${NEXT_ASTRA_DB_COLLECTION}`);
    }
  } catch (error) {
    console.error("❌ Fehler beim Erstellen der Collection:", error);
    throw error;
  }
}

/**
 * Lädt PDF-Daten aus allen Programm-Ordnern
 */
async function loadSampleData() {
  const collection = await db.collection(NEXT_ASTRA_DB_COLLECTION);
  const basePath = "/Users/silvandarioprivat/Desktop/courses_to_parse/";
  const mastersFolders = ["macfin", "MBI", "MGM", "MiMM"];
  
  console.log(`\n🔄 Starte Datenimport aus ${mastersFolders.length} Programmen`);
  
  for (const program of mastersFolders) {
    const programPath = path.join(basePath, program);
    console.log(`\n📂 Verarbeite Programm: ${program}`);
    
    try {
      const files = await fs.promises.readdir(programPath);
      const pdfFiles = files.filter((f) => f.endsWith(".pdf"));
      
      console.log(`📚 ${pdfFiles.length} PDF-Dateien in ${program} gefunden`);
      
      for (const pdfFile of pdfFiles) {
        const filePath = path.join(programPath, pdfFile);
        console.log(`\n🔍 Verarbeite ${pdfFile}...`);
        
        try {
          // Extrahiere Metadaten
          const metadata = await parsePDF(filePath);
          
          if (!metadata) {
            console.log(`⚠️ Überspringe leere Metadaten: ${filePath}`);
            continue;
          }
          
          // Extrahiere Text ohne letzte Seite (rechtliche Hinweise)
          const content = await parsePdfWithoutLastPage(filePath);
          if (!content) {
            console.log(`⚠️ Überspringe leeren Inhalt: ${filePath}`);
            continue;
          }
          
          // Index vollständiges Dokument
          const largeDocChunks = await splitter.splitText(content);
          console.log(`🔪 Teile vollständiges Dokument in ${largeDocChunks.length} Chunks auf...`);

          for (let i = 0; i < largeDocChunks.length; i++) {
            const chunk = largeDocChunks[i];
            
            const embedding = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: chunk,
              encoding_format: "float",
            });
            
            await collection.insertOne({
              $vector: embedding.data[0].embedding,
              text: chunk,
              metadata: {
                ...metadata,
                source: pdfFile,
                program,
                path: filePath,
                type: "full", // Keep this as "full" to identify this is part of the full document
                fullDocumentId: pdfFile, // Add a unique ID to link these chunks
                chunkIndex: i,
                totalChunks: largeDocChunks.length,
              },
            });
          }
          console.log(`✅ Vollständiges Dokument in ${largeDocChunks.length} Chunks indexiert`);

          
          // Index Chunks
          const chunks = await splitter.splitText(content);
          console.log(`🔪 Teile in ${chunks.length} Chunks auf...`);
          
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`  🔄 Verarbeite Chunk ${i+1}/${chunks.length}...`);
            
            const embedding = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: chunk,
              encoding_format: "float",
            });
            
            await collection.insertOne({
              $vector: embedding.data[0].embedding,
              text: chunk,
              metadata: {
                ...metadata,
                source: pdfFile,
                program,
                path: filePath,
                type: "chunk",
                chunkIndex: i,
                totalChunks: chunks.length,
              },
            });
          }
          
          console.log(`✅ Indexiert: ${pdfFile} - ${chunks.length} Chunks`);
        } catch (err) {
          console.error(`❌ Fehler bei der Verarbeitung von ${pdfFile}:`, err);
        }
      }
    } catch (error) {
      console.error(`❌ Fehler beim Zugriff auf Verzeichnis ${programPath}:`, error);
    }
  }
}

/**
 * Entfernt die letzte Seite aus dem PDF und gibt den restlichen Text zurück
 */
async function parsePdfWithoutLastPage(filePath: string): Promise<string> {
  try {
    console.log(`🔍 Extrahiere Text ohne letzte Seite: ${path.basename(filePath)}`);
    const dataBuffer = await fs.promises.readFile(filePath);
    const pdf = await pdfParse(dataBuffer);
    
    // Methode 1: Bei Formfeed-Zeichen aufteilen (zuverlässiger)
    const allPages = pdf.text.split("\f");
    console.log(`📄 PDF enthält ${allPages.length} Seiten`);
    
    if (allPages.length > 1) {
      const contentWithoutLast = allPages.slice(0, -1).join("\f");
      console.log(`✅ Letzte Seite entfernt, ${allPages.length-1} Seiten verbleiben`);
      return contentWithoutLast.trim();
    }
    
    // Falls keine Formfeed-Zeichen gefunden wurden, versuche alternative Methode
    console.log(`⚠️ Keine Formfeed-Zeichen gefunden, verwende alternative Methode`);
    
    // Methode 2: Versuche, nach Seitenzahlen zu splitten
    const pagePattern = /Page \d+ \/ \d+|Fact sheet version: \d+\.\d+ as of \d+\/\d+\/\d{4}/g;
    const matches = [...pdf.text.matchAll(pagePattern)];
    
    if (matches.length > 1) {
      const lastPageStart = matches[matches.length - 1].index!;
      console.log(`✅ Letzte Seite bei Position ${lastPageStart} gefunden`);
      return pdf.text.substring(0, lastPageStart).trim();
    }
    
    console.log(`⚠️ Keine Seitenmarkierungen gefunden, verwende vollständigen Text`);
    return pdf.text.trim();
  } catch (error) {
    console.error(`❌ Fehler beim Parsen von PDF ${filePath}:`, error);
    return "";
  }
}

/**
 * Hilfsfunktion zum Testen der Metadatenextraktion
 */
function testMetadataExtraction(sampleText: string) {
  console.log("🧪 Teste Metadatenextraktion mit Beispieltext");
  const extracted = extractMetadata(sampleText, "test-sample.pdf", true);
  console.log("\n📝 Testergebnisse:");
  console.log(JSON.stringify(extracted, null, 2));
  return extracted;
}

/**
 * Hauptfunktion zum Ausführen des Skripts
 */
async function main() {
  console.log("🚀 PDF-Metadatenextraktion und Indexierung startet...");
  
  try {
    // Beispieltext für Tests
    const sampleText = `8,126: Advanced Auditing & Audit Data Analytics
ECTS credits: 6
Overview examination/s
(binding regulations see below)
decentral - Active participation, Analog, Individual work individual grade (20%)
Examination time: Term time
decentral - Presentation, Analog, Group work group grade (80%)
Examination time: Term time
Attached courses
Timetable -- Language -- Lecturer
8,126,1.00 Advanced Auditing & Audit Data Analytics -- English -- Meister Nicole, Schmidt Peter`;

    // Teste Parser mit Beispieldaten
    console.log("\n=== 🧪 Test mit Beispieldaten ===");
    testMetadataExtraction(sampleText);
    
    // Erstelle Collection
    console.log("\n=== 🏗️ Collection vorbereiten ===");
    await createCollection();
    
    // Lade PDF-Daten
    console.log("\n=== 📥 PDF-Daten laden ===");
    await loadSampleData();
    
    console.log("\n✅ Datenladung erfolgreich abgeschlossen!");
  } catch (error) {
    console.error("\n❌ Fehler in der Hauptausführung:", error);
  }
}

// Führe das Skript aus, wenn es direkt aufgerufen wird
if (require.main === module) {
  main();
}

// Exportiere Funktionen für die Verwendung in anderen Modulen
export {
  extractMetadata,
  parsePDF,
  testMetadataExtraction,
  parsePdfWithoutLastPage,
  main
};