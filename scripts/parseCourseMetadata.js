const fs = require('fs');
const pdfParse = require('pdf-parse');

/**
 * Extract course metadata from PDF text content
 * @param {string} text - The text content of the PDF
 * @returns {Object} - Structured metadata object
 */
function extractMetadata(text) {
  const metadata = {};
  const debug = false; // Set to true to enable extensive debugging
  
  // Normalize text by adding spaces between words where missing
  // This is especially important for PDF-extracted text where words are often merged
  let normalizedText = text;
  
  // Optional debug output
  if (debug) {
    console.log("First 1000 chars of PDF content:");
    console.log(text.substring(0, 1000));
  }
  
  // Course Number & Title - improved pattern matching
  const titleMatch = text.match(/(\d{1,3},\d{1,3}):\s*([^\n]+)/);
  if (titleMatch) {
    metadata.courseNumber = titleMatch[1];
    metadata.title = titleMatch[2].replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (debug) console.log(`Found course: ${metadata.courseNumber} - ${metadata.title}`);
  } else if (debug) {
    console.log("Failed to match course number and title");
  }
  
  // ECTS Credits - improved pattern to handle missing spaces
  const ectsMatch = text.match(/ECTS\s*credits:?\s*(\d+)/i);
  if (ectsMatch) {
    metadata.ects = parseInt(ectsMatch[1], 10);
    if (debug) console.log(`Found ECTS: ${metadata.ects}`);
  } else if (debug) {
    console.log("Failed to match ECTS credits");
  }
  
  // Language & Lecturers - more flexible pattern for merged text
  // First try standard format
  let lectureLinePattern = /(\d{1,3},\d{1,3},\d{1,2}(?:\.00)?)[^-]+ -- ([^-]+) -- ([^-\n]+)/;
  let lectureLine = text.match(lectureLinePattern);
  
  // If that fails, try with no spaces around double hyphens
  if (!lectureLine) {
    lectureLinePattern = /(\d{1,3},\d{1,3},\d{1,2}(?:\.00)?)[^-]+--([^-]+)--([^-\n]+)/;
    lectureLine = text.match(lectureLinePattern);
  }
  
  if (lectureLine) {
    metadata.language = lectureLine[2].trim();
    metadata.lecturers = lectureLine[3].split(',').map(s => {
      // Handle names that might be merged without spaces
      return s.trim().replace(/([a-z])([A-Z])/g, '$1 $2');
    });
    if (debug) {
      console.log(`Found language: ${metadata.language}`);
      console.log(`Found lecturers: ${metadata.lecturers.join(', ')}`);
    }
  } else if (debug) {
    console.log("Failed to match language and lecturers");
    // Try to find a line that might contain lecturer information
    const possibleLecturerLines = text.split('\n').filter(line => 
      line.includes('--') && (
        line.toLowerCase().includes('english') || 
        line.toLowerCase().includes('deutsch') ||
        line.includes('8,126,1.00')
      )
    );
    if (possibleLecturerLines.length > 0) {
      console.log("Possible lecturer lines found:");
      possibleLecturerLines.forEach(line => console.log(`- ${line}`));
      
      // Try to extract from the most likely candidate
      const bestCandidate = possibleLecturerLines[0];
      const parts = bestCandidate.split('--');
      if (parts.length >= 3) {
        metadata.language = parts[1].trim();
        metadata.lecturers = parts[2].split(',').map(s => 
          s.trim().replace(/([a-z])([A-Z])/g, '$1 $2')
        );
        if (debug) {
          console.log(`Extracted language: ${metadata.language}`);
          console.log(`Extracted lecturers: ${metadata.lecturers.join(', ')}`);
        }
      }
    }
  }
  
  // Examinations - handle text without spaces
  // First try with spaces
  let examSections = [...text.matchAll(/decentral\s*-\s*([^,]+),\s*([^,]+),\s*([^(]+)\s+(individual|group)\s+grade\s*\((\d+%)\)/gi)];
  
  // If that fails, try without spaces
  if (examSections.length === 0) {
    const examPattern = /decentral-([^,]+),([^,]+),([^(]+)(individual|group)grade\((\d+%)\)/gi;
    examSections = [...text.matchAll(examPattern)];
  }
  
  if (examSections.length > 0) {
    metadata.examinations = examSections.map(e => ({
      type: e[1].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
      mode: e[2].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
      format: e[3].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
      gradeType: `${e[4].trim()} grade`,
      weighting: e[5].trim()
    }));
    if (debug) console.log(`Found ${examSections.length} examination sections`);
  } else {
    if (debug) console.log("Failed to match examination sections using regex");
    metadata.examinations = [];
    
    // Look for decentral lines and try manual parsing
    const examLines = text.split('\n').filter(line => 
      line.toLowerCase().includes('decentral') && 
      line.includes('grade') && 
      line.includes('%')
    );
    
    if (examLines.length > 0) {
      if (debug) {
        console.log("Found potential exam lines:");
        examLines.forEach(line => console.log(`- ${line}`));
      }
      
      examLines.forEach(line => {
        try {
          // Try to parse the line manually
          const gradeTypeMatch = line.match(/(individual|group)grade\((\d+%)\)/i);
          if (gradeTypeMatch) {
            const gradeType = gradeTypeMatch[1].toLowerCase();
            const weighting = gradeTypeMatch[2];
            
            // Extract the remaining information
            const start = line.indexOf('-') + 1;
            const end = line.indexOf(gradeType + 'grade');
            if (start > 0 && end > start) {
              const middlePart = line.substring(start, end).trim();
              const parts = middlePart.split(',');
              
              if (parts.length >= 3) {
                const exam = {
                  type: parts[0].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
                  mode: parts[1].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
                  format: parts[2].trim().replace(/([a-z])([A-Z])/g, '$1 $2'),
                  gradeType: `${gradeType} grade`,
                  weighting: weighting
                };
                metadata.examinations.push(exam);
                if (debug) console.log(`Manually extracted exam: ${JSON.stringify(exam)}`);
              }
            }
          }
        } catch (err) {
          if (debug) console.log(`Error parsing exam line: ${err.message}`);
        }
      });
    }
  }
  
  return metadata;
}

/**
 * Parse PDF file and extract metadata
 * @param {string} filePath - Path to the PDF file
 */
async function parsePDF(filePath) {
  try {
    console.log(`Processing file: ${filePath}`);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      return null;
    }
    
    const dataBuffer = fs.readFileSync(filePath);
    console.log(`File size: ${dataBuffer.length} bytes`);
    
    // PDF parse options with improved text extraction
    const options = {
      // Use custom rendering to preserve layout better
      pagerender: function(pageData) {
        return pageData.getTextContent()
          .then(function(textContent) {
            let lastY, text = '';
            for (let item of textContent.items) {
              if (lastY == item.transform[5] || !lastY) {
                text += item.str;
              } else {
                text += '\n' + item.str;
              }
              lastY = item.transform[5];
            }
            return text;
          });
      }
    };
    
    const data = await pdfParse(dataBuffer, options);
    console.log(`PDF parsed. Total pages: ${data.numpages}`);
    
    const extracted = extractMetadata(data.text);
    console.log("\nExtracted Metadata:");
    console.log(JSON.stringify(extracted, null, 2));
    return extracted;
  } catch (error) {
    console.error('Error parsing PDF:', error);
    return null;
  }
}

/**
 * Test function to validate parser with example text
 * @param {string} sampleText - Example text to test parser with
 */
function testParser(sampleText) {
  console.log("Testing metadata extraction with sample text");
  const extracted = extractMetadata(sampleText);
  console.log("\nTest Parser Results:");
  console.log(JSON.stringify(extracted, null, 2));
  return extracted;
}

/**
 * Fix common PDF text issues like merged words
 * @param {string} text - The raw text from PDF
 * @returns {string} - Text with spacing fixes
 */
function normalizePdfText(text) {
  // Add spaces between camelCase words
  return text.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// If running directly from command line
if (require.main === module) {
  const filePath = process.argv[2] || '/Users/silvandarioprivat/Desktop/courses_to_parse/MiMM_Anwendungsprojekt_II.pdf';
  
  // Example text for testing without actual PDF
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

  // Test the parser with sample data
  console.log("=== Testing with sample data ===");
  testParser(sampleText);
  
  // Parse actual PDF if file path is provided
  console.log("\n=== Processing PDF file ===");
  parsePDF(filePath).then(() => {
    console.log("PDF processing complete");
  });
}

// Export functions for use in other modules
module.exports = {
  extractMetadata,
  parsePDF,
  testParser,
  normalizePdfText
};