import { streamText, type ModelMessage } from "ai";

const MAX_STEPS = 10;

export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
) {
  let step = 0;

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- 🪜 Step ${step} ---`);

    const result = streamText({
      model,
      system,
      tools,
      messages,
      // 不设置 stopWhen，每次只跑一步
    });

    let hasToolCall = false;
    let fullText = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          fullText += part.text;
          break;

        case "tool-call":
          hasToolCall = true;
          console.log(
            `\n   [🔧 Tool Call: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;

        case "tool-result":
          console.log(`   [⚙️ Tool Result: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    // 拿到这一步的完整结果，追加到消息历史
    const stepMessages = await result.response;
    
    console.log(`\n 步骤 ${step} 的返回 ${JSON.stringify(stepMessages, null, 2)} \n`)
            
    messages.push(...stepMessages.messages);

    // 退出条件：模型没有调用任何工具，说明它认为可以直接回复了
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("   -> 模型还在工作，继续下一步...");
  }

  if (step === MAX_STEPS) {
    console.log(`\n⚠️ 已达到最大步骤数 ${MAX_STEPS}，强制退出循环。`);
  }
}
