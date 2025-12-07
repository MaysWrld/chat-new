// /functions/api/chat.js - 兼容 Grok/Gemini 双 API 版本

import { getConfig } from '../auth'; // 移除了 isAuthenticated，因为 chat 接口不需要认证

const MAX_HISTORY_MESSAGES = 10; // 最大历史消息数量

const SESSION_COOKIE_NAME = 'chat_session_id';
const COOKIE_TTL_SECONDS = 3600 * 24 * 30; // 30天

function getSessionId(request) {
    const cookieHeader = request.headers.get('Cookie');
    if (cookieHeader) {
        const cookies = cookieHeader.split(';').map(c => c.trim().split('='));
        const sessionId = cookies.find(([name]) => name === SESSION_COOKIE_NAME)?.[1];
        return sessionId;
    }
    return null;
}

function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * 辅助函数：将历史消息转换为 Grok (OpenAI) API 格式
 * @param {Array} history 历史消息数组
 * @param {string} userMessage 当前用户消息
 * @param {string} personaPrompt AI风格指令
 * @returns {Array<Object>}
 */
function buildGrokMessages(history, userMessage, personaPrompt) {
    const messages = [];

    // 1. 插入 System Prompt (如果存在)
    if (personaPrompt) {
        messages.push({
            role: 'system',
            content: personaPrompt
        });
    }

    // 2. 插入历史消息 (最多 MAX_HISTORY_MESSAGES 轮对话)
    const historyToUse = history.slice(-MAX_HISTORY_MESSAGES);
    
    for (const msg of historyToUse) {
        messages.push({
            // Grok API role: 'user' 或 'assistant' (对应 model)
            role: msg.role === 'user' ? 'user' : 'assistant', 
            content: msg.text 
        });
    }

    // 3. 插入当前用户消息
    messages.push({
        role: "user",
        content: userMessage
    });

    return messages;
}

/**
 * 辅助函数：将历史消息转换为 Gemini API 格式 (保持原逻辑不变)
 * 📌 注意：不再需要将 personaPrompt 拼接到消息中，因为 Grok 风格处理了
 * @param {Array} history 历史消息数组
 * @param {string} userMessage 当前用户消息
 * @returns {Array<Object>}
 */
function buildGeminiContents(history, userMessage) {
    const contents = [];
    
    // 历史消息部分 (最多 MAX_HISTORY_MESSAGES 轮对话)
    const historyToUse = history.slice(-MAX_HISTORY_MESSAGES);
    
    for (const msg of historyToUse) {
        contents.push({
            role: msg.role === 'user' ? 'user' : 'model', 
            parts: [{ text: msg.text }]
        });
    }

    // 插入当前用户消息
    contents.push({
        role: "user",
        parts: [{ text: userMessage }]
    });

    return contents;
}


export async function onRequest({ request, env }) {
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    }

    let sessionId = getSessionId(request);
    let setCookie = false;

    if (!sessionId) {
        sessionId = generateUuid();
        setCookie = true;
    }

    try {
        const body = await request.json();
        // 假设 body.contents 总是来自前端的最新消息
        const userContents = body.contents; 
        const userMessage = userContents[userContents.length - 1].parts[0].text; 

        const config = await getConfig(env);

        if (!config.apiKey || !config.apiUrl) {
            return new Response(JSON.stringify({ error: 'AI API Key 或 URL 未配置。请联系管理员。' }), { status: 500 });
        }
        
        const historyData = await env.HISTORY.get(sessionId, { type: 'json' });
        const history = Array.isArray(historyData) ? historyData : [];
        
        const finalModel = config.modelName || 'gemini-2.5-flash'; 
        const temperature = parseFloat(config.temperature) || 0.7;

        // ------------------ 🚨 核心逻辑：判断 API 类型 🚨 ------------------
        // 通过检查 URL 来判断是 Grok/OpenAI 风格还是 Gemini 风格
        const isGrokLikeApi = config.apiUrl.includes('x.ai') || config.apiUrl.includes('openai.com') || config.apiUrl.includes('/chat/completions');
        
        let apiRequestBody = {};
        let apiUrl = config.apiUrl.replace(/\/$/, ''); // 移除末尾斜杠
        let apiHeaders = { 'Content-Type': 'application/json' };

        if (isGrokLikeApi) {
            // --- Grok/OpenAI 风格 API ---
            apiRequestBody = {
                messages: buildGrokMessages(history, userMessage, config.personaPrompt),
                model: finalModel, // 模型名在 body 中
                temperature: temperature,
                stream: false,
                // ... 可以添加其他 Grok/OpenAI 参数，如 max_tokens
            };
            
            // Grok/OpenAI API URL 是完整的，不需要拼接
            // 添加 Bearer Token 认证头
            apiHeaders['Authorization'] = `Bearer ${config.apiKey}`;
            
        } else {
            // --- 默认为 Gemini 风格 API ---
            apiRequestBody = {
                contents: buildGeminiContents(history, userMessage),
                generationConfig: {
                    temperature: temperature, 
                    // 📌 修正：为了兼容性，我们将 systemInstruction 放到 buildGrokMessages 兼容 Grok
                    //      对于 Gemini，我们暂时不传 systemInstruction，依赖之前 admin.js 里的
                    //      buildGeminiContents 逻辑（如果需要，应将 personaPrompt 传给 buildGeminiContents，
                    //      并让其拼接给第一个用户消息，但本版本为了双兼容已简化。）
                }, 
            };
            
            // Gemini API URL 需要拼接模型和 Key
            apiUrl = apiUrl + '/models/' + finalModel + ':generateContent?key=' + config.apiKey;
        }
        // ------------------------------------------------------------------

        // 4. 调用 API
        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: apiHeaders,
            body: JSON.stringify(apiRequestBody)
        });
        
        const data = await apiResponse.json();
        
        if (!apiResponse.ok) {
            const errorMessage = data.error?.message || data.error || apiResponse.statusText;
            return new Response(JSON.stringify({ error: `API 错误 (${apiResponse.status}): ${errorMessage}` }), { status: apiResponse.status });
        }
        
        // ------------------ 🚨 响应解析：根据 API 类型获取文本 🚨 ------------------
        let aiText = '';
        if (isGrokLikeApi) {
            // Grok/OpenAI API 响应结构
            aiText = data.choices?.[0]?.message?.content;
        } else {
            // Gemini API 响应结构 (保持不变)
            aiText = data.candidates?.[0]?.content?.parts?.[0]?.text; 
        }

        if (!aiText) {
             return new Response(JSON.stringify({ error: 'AI 返回了一个空响应。' }), { status: 500 });
        }
        
        // 💡 清理文本开头的空白行和空格
        aiText = aiText.replace(/^\s+/, '');
        
        // 6. 更新历史记录 (兼容前后端数据结构，保持不变)
        const newHistory = [
            ...history,
            { role: 'user', text: userMessage }, 
            { role: 'model', text: aiText }
        ];
        
        const maxHistoryToSave = (MAX_HISTORY_MESSAGES + 1) * 2; 
        const historyToSave = newHistory.slice(-maxHistoryToSave);
        
        await env.HISTORY.put(sessionId, JSON.stringify(historyToSave), { expirationTtl: COOKIE_TTL_SECONDS });

        // 7. 构造响应头 (确保 Grok 风格能被前端识别，这里我们将 Grok 的响应转换为 Gemini 兼容格式)
        const responseData = {
             // 构造一个与前端期待的 data.candidates 结构兼容的响应体
             candidates: [{
                 content: {
                     parts: [{ text: aiText }]
                 }
             }]
        };

        const headers = { 'Content-Type': 'application/json' };
        if (setCookie) {
            headers['Set-Cookie'] = `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; Max-Age=${COOKIE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
        }

        return new Response(JSON.stringify(responseData), { status: 200, headers: headers });

    } catch (error) {
        console.error("Chat Worker Error:", error);
        return new Response(JSON.stringify({ error: `系统错误: ${error.message}` }), { status: 500 });
    }
}
