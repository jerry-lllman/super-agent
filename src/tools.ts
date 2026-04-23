import { jsonSchema } from 'ai'
    
export const weatherTool = {
    description: 'Check the weather forecast for a specific city',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            city: { type: 'string', description: 'City names, such as "Beijing" and "Shanghai"' },
        },
        required: ['city'],
        additionalProperties: false
    }),
    execute: async ({ city }: { city: string }) => {
        const mockWeather: Record<string, string> = {
            'Beijing': 'Sunny, 15-25°C, south-easterly wind force 2',
            'Shanghai': 'Cloudy, 18-22°C, south-westerly wind force 3',
            'Guangzhou': 'Showers, 22-28°C, southerly wind force 2'
        }
        
        return mockWeather[city] || `${city}: No data available`
    }
}

export const calculatorTool = {
    description: "Calculate the result of a mathematucal expression. Use this when a user's query involves a mathematical operation",
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            expression: { type: 'string', description: 'Mathematical expressions, such as "2 + 3 * 4"' }
        },
        required: ['expression'],
        additionalProperties: false
    }),
    execute: async ({ expression }: { expression: string }) => {
        try {
            // 生产环境不要使用 eval，这里纯演示
            const result = new Function(`return ${expression}`)()
            return `${expression} = ${result}`
        } catch {
            return `Cannot calculate: ${expression}`
        }
    }
}