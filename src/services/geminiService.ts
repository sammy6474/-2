import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface MedicationInfo {
  name: string;
  schedule: string[];
  instructions: string;
}

export async function analyzePrescription(base64Image: string): Promise<MedicationInfo[]> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Image,
              },
            },
            {
              text: "이 약봉투 사진에서 '모든' 약의 이름, 복용 시간(아침, 점심, 저녁 중 선택), 그리고 주의사항을 추출해줘. 여러 개의 약이 있다면 각각의 정보를 모두 포함해야 해. 결과는 반드시 JSON 배열 형식으로 반환해줘.",
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: "약 이름" },
              schedule: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "복용 시간 (morning, afternoon, evening 중 해당되는 것들)" 
              },
              instructions: { type: Type.STRING, description: "주의사항" },
            },
            required: ["name", "schedule", "instructions"],
          },
        },
      },
    });

    if (response.text) {
      return JSON.parse(response.text) as MedicationInfo[];
    }
    return [];
  } catch (error) {
    console.error("Gemini API Error:", error);
    return [];
  }
}

export async function countMedicationPouches(base64Image: string): Promise<number | null> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Image,
              },
            },
            {
              text: "이 사진에는 줄줄이 연결된 약봉지들이 있어. 사진 속에서 '남아있는 약봉지의 총 개수'가 몇 개인지 정확히 세어줘. 숫자만 반환해줘.",
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            count: { type: Type.NUMBER, description: "약봉지의 개수" },
          },
          required: ["count"],
        },
      },
    });

    if (response.text) {
      const data = JSON.parse(response.text);
      return data.count;
    }
    return null;
  } catch (error) {
    console.error("Gemini Count Error:", error);
    return null;
  }
}
