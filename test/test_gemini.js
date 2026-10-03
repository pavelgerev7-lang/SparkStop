import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

async function testGemini() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  for (const modelName of ['gemini-3.6-flash', 'models/gemini-3.6-flash', 'gemini-3.0-flash', 'gemini-2.0-flash-exp']) {
    try {
      console.log(`Testing model: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const res = await model.generateContent('Кажи "Тест ОК"');
      console.log(`✅ Success with ${modelName}:`, res.response.text());
      break;
    } catch (e) {
      console.warn(`❌ Failed with ${modelName}:`, e.message);
    }
  }
}

testGemini();
