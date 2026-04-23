import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from 'node:readline';

import { createMockModel } from "./mock-model";
import { weatherTool, calculatorTool } from './tools'
import { agentLoop } from './agent-loop'

const llm = createOpenAI({
  baseURL: process.env.OPENAI_API_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_API_KEY
  ? llm.chat("deepseek-chat")
  : createMockModel();

const rl = createInterface({
    input: process.stdin,
    output: process.stdout
})

const systemPrompt = `You are Super Agent, an AI assistant capable of invoking tools. When necessary, proactively use tools to retrieve information; do not fabricate data.`

const tools = { get_weather: weatherTool, calculator: calculatorTool }

const messages: ModelMessage[] = []

function ask() {
    rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!')
            rl.close()
            return
        }
        
        messages.push({ role: 'user', content: trimmed })
        
        await agentLoop(model, tools, messages, systemPrompt)
        
        ask()
    })
}

console.log('🤖 Super Agent v0.2 —— Agent Loop (type "exit" to quit)\n')
ask()