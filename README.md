# HSG Course Insight Chatbot

Welcome to the **HSG Course Insight Chatbot**, your intelligent assistant specifically designed to enhance your educational experience at the University of St. Gallen (HSG). Leveraging advanced AI techniques and meticulous data preparation, this chatbot provides accurate, relevant, and precise information about courses, examinations, and frequently asked questions related to HSG programs.

## 🌟 Key Features

### 📚 Intelligent Data Extraction

- **Precision PDF Parsing**: Efficiently extracts detailed course information including titles, ECTS credits, lecturers, semester details, and examination formats from PDF documents.
- **Context-Aware Chunking**: Optimized chunk sizes and overlaps ensure contextual accuracy and improved query responses.

### 🔍 Advanced Semantic Search

- **Vectorized Content Storage**: Utilizes powerful OpenAI embeddings to convert textual content from PDFs and CSVs into vectorized data, stored securely and efficiently in AstraDB.
- **Metadata-Enhanced Queries**: Captures crucial metadata such as course titles, ECTS, lecturers, and examination details, drastically enhancing the accuracy of responses and significantly reducing content fabrication.

### 🚀 Real-Time Interaction

- **Dynamic Query Handling**: Automatically determines the user's intent (detailed syllabus, FAQ, general course information) and responds appropriately, ensuring a seamless user experience.
- **Streamlined AI Responses**: Real-time AI-generated responses streamed efficiently from OpenAI models, leveraging semantic similarity to deliver precisely what users need.

## 🛠️ Technical Highlights

- **Framework & Tools**:
  - **Next.js** for robust API development and frontend integration.
  - **TypeScript & Node.js** scripts for seamless data extraction and preparation.
  - **AstraDB** for highly performant vector database storage, optimized with cosine similarity metrics for semantic querying.
  - **OpenAI's GPT-4o & Embedding Models** for state-of-the-art natural language processing and understanding.

- **Optimized Data Workflow**:
  - Content extraction via specialized scripts (`npm run seed`) to ensure con
