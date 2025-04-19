const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { PDFDocument } = require('pdf-lib');

const basePath = "/Users/silvandarioprivat/Desktop/courses";
const outputPath = "/Users/silvandarioprivat/Desktop/courses_to_parse";
const mastersFolders = ["macfin", "MBI", "MGM", "MiMM"];

if (!fs.existsSync(outputPath)) {
  fs.mkdirSync(outputPath);
}

async function processPDF(inputPath, outputPath) {
  const existingPdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const totalPages = pdfDoc.getPageCount();

  if (totalPages < 2) {
    console.log(`⚠️  Datei ${inputPath} hat nur eine Seite, wird übersprungen.`);
    return;
  }

  const newPdf = await PDFDocument.create();
  const pages = await newPdf.copyPages(pdfDoc, [...Array(totalPages - 1).keys()]);
  pages.forEach((page) => newPdf.addPage(page));

  const newPdfBytes = await newPdf.save();
  fs.writeFileSync(outputPath, newPdfBytes);
}

(async () => {
  for (const folder of mastersFolders) {
    const folderPath = path.join(basePath, folder);
    const pdfFiles = glob.sync(`${folderPath}/*.pdf`);

    for (const file of pdfFiles) {
      const fileName = path.basename(file);
      const newName = `${folder}_${fileName}`;
      const outPath = path.join(outputPath, newName);

      try {
        await processPDF(file, outPath);
        console.log(`✅ ${newName} gespeichert.`);
      } catch (err) {
        console.error(`❌ Fehler bei ${file}:`, err);
      }
    }
  }
})();