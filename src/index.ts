import "dotenv/config";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from 'node:readline';

import { createMockModel } from "./mock-model";
import { weatherTool, calculatorTool } from './tools'

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
        
        const result = streamText({
            model,
            system: systemPrompt,
            tools,
            messages,
            stopWhen: stepCountIs(5) // 最多跑 5 步
        })
        
        process.stdout.write('Assistant: ')
        let fullResponse = ''
        
        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'text-delta':
                    process.stdout.write(part.text)
                    fullResponse += part.text
                    break
                case 'tool-call':
                    console.log(`\n [🔧 Call tool: ${part.toolName}(${JSON.stringify(part.input)})]`)
                    break
                case 'tool-result':
                    console.log(`  [⚙️ Tool return: ${JSON.stringify(part.output)}]`)
                    break
            }
        }
        console.log() // 换行
        
        messages.push({ role: 'assistant', content: fullResponse })
        ask()
    })
}

console.log('🤖 Super Agent v0.2 —— Agent Loop (type "exit" to quit)\n')
ask()