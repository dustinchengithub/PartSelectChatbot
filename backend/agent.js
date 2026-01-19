import Anthropic from '@anthropic-ai/sdk';
import { searchPart, checkCompatibility, getTroubleshootingInfo } from './scraper.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a helpful customer service agent for PartSelect, specializing in refrigerator and dishwasher parts.

Your capabilities:
- Help customers find parts by part number
- Provide installation instructions and guidance
- Check if parts are compatible with specific appliance models
- Troubleshoot common refrigerator and dishwasher problems
- Provide other product information for refrigerator and dishwasher parts
- Focus on user experience and clarity

Guidelines:
- Only assist with refrigerator and dishwasher parts. Politely decline requests for other appliance types or questions unrelated to parts.
- Be concise, helpful, and professional
- When you have part information, summarize the key details
- If you can't find specific information, provide general guidance based on your knowledge
- Always recommend customers verify compatibility on PartSelect.com before purchasing`;

const tools = [
  {
    name: "get_part_info",
    description: "Search for a part by its part number and get details including price, availability, description, and installation information. Use this when a customer asks about a specific part number.",
    input_schema: {
      type: "object",
      properties: {
        part_number: {
          type: "string",
          description: "The part number to search for (e.g., PS11752778)"
        }
      },
      required: ["part_number"]
    }
  },
  {
    name: "check_compatibility",
    description: "Check if a specific part is compatible with an appliance model. Use this when a customer wants to know if a part fits their specific model.",
    input_schema: {
      type: "object",
      properties: {
        part_number: {
          type: "string",
          description: "The part number to check"
        },
        model_number: {
          type: "string",
          description: "The appliance model number (e.g., WDT780SAEM1)"
        }
      },
      required: ["part_number", "model_number"]
    }
  },
  {
    name: "troubleshoot",
    description: "Get troubleshooting information for a refrigerator or dishwasher problem. Use this when a customer describes an issue with their appliance.",
    input_schema: {
      type: "object",
      properties: {
        appliance: {
          type: "string",
          enum: ["refrigerator", "dishwasher"],
          description: "The type of appliance"
        },
        symptom: {
          type: "string",
          description: "The problem or symptom (e.g., 'not making ice', 'not draining', 'leaking water')"
        }
      },
      required: ["appliance", "symptom"]
    }
  }
];

async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case "get_part_info":
      return await searchPart(toolInput.part_number);
    case "check_compatibility":
      return await checkCompatibility(toolInput.part_number, toolInput.model_number);
    case "troubleshoot":
      return await getTroubleshootingInfo(toolInput.appliance, toolInput.symptom);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

export async function chat(messages) {
  // Convert messages to Anthropic format
  const anthropicMessages = messages.map(msg => ({
    role: msg.role,
    content: msg.content
  }));

  // Track part data retrieved during this conversation turn
  const partsData = [];

  let response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: tools,
    messages: anthropicMessages
  });

  // Handle tool use loop
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(block => block.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      console.log(`Executing tool: ${toolUse.name}`, toolUse.input);
      const result = await executeTool(toolUse.name, toolUse.input);
      console.log(`Tool result:`, result);

      // Capture part data for rich rendering
      if (toolUse.name === "get_part_info" && result && !result.error) {
        partsData.push(result);
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result)
      });
    }

    // Continue conversation with tool results
    anthropicMessages.push({
      role: "assistant",
      content: response.content
    });
    anthropicMessages.push({
      role: "user",
      content: toolResults
    });

    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: tools,
      messages: anthropicMessages
    });
  }

  // Extract text response
  const textBlock = response.content.find(block => block.type === "text");
  const text = textBlock ? textBlock.text : "I apologize, but I couldn't generate a response.";

  // Return both text and any part data
  return {
    text,
    parts: partsData
  };
}
