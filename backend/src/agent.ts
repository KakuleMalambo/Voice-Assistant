// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  multimodal,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env.local');
dotenv.config({ path: envPath });

// Debug environment variables
console.log('Environment path:', envPath);
console.log('BRAVE_SEARCH_API_KEY exists:', !!process.env.BRAVE_SEARCH_API_KEY);
console.log('BRAVE_SEARCH_API_KEY first chars:', process.env.BRAVE_SEARCH_API_KEY ? process.env.BRAVE_SEARCH_API_KEY.substring(0, 4) : 'not found');
console.log('All env keys with BRAVE:', Object.keys(process.env).filter(key => key.includes('BRAVE')));

// Path to the rooms data file
const roomsFilePath = path.join(__dirname, '../data/rooms.json');

// Interface for room data
interface Room {
  name: string;
  temperature: number;
}

interface RoomsData {
  house: {
    rooms: Room[];
  };
}

// Function to read the rooms data
async function readRoomsData(): Promise<RoomsData> {
  try {
    const data = await fs.readFile(roomsFilePath, 'utf-8');
    return JSON.parse(data) as RoomsData;
  } catch (error) {
    console.error('Error reading rooms data:', error);
    throw new Error('Failed to read rooms data');
  }
}

// Function to write the rooms data
async function writeRoomsData(data: RoomsData): Promise<void> {
  try {
    await fs.writeFile(roomsFilePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error writing rooms data:', error);
    throw new Error('Failed to write rooms data');
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    const model = new openai.realtime.RealtimeModel({
      instructions: `You are a helpful assistant with internet access and control over home temperature. 
      
IMPORTANT: When asked about current events, news, facts, or any information that might require up-to-date knowledge, ALWAYS use the searchWeb function to find the most relevant information. Do not rely on your training data for current information.

You can also report and control home room temperatures when asked.`,
    });

    const fncCtx: llm.FunctionContext = {
      weather: {
        description: 'Get the weather in a location',
        parameters: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => {
          console.debug(`executing weather function for ${location}`);
          const response = await fetch(`https://wttr.in/${location}?format=%C+%t`);
          if (!response.ok) {
            throw new Error(`Weather API returned status: ${response.status}`);
          }
          const weather = await response.text();
          return `The weather in ${location} right now is ${weather}.`;
        },
      },
      searchWeb: {
        description: 'Search the web for current information on a topic using Brave Search',
        parameters: z.object({
          query: z.string().describe('The search query to look up'),
        }),
        execute: async ({ query }) => {
          console.debug(`executing web search for query: ${query}`);
          
          // Check if BRAVE_SEARCH_API_KEY is set
            const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
          if (!braveApiKey) {
            console.error('BRAVE_SEARCH_API_KEY is not set in the environment variables');
            return "Error: Brave Search API key is not configured. Please set the BRAVE_SEARCH_API_KEY environment variable.";
          }
          
          try {
            // Properly construct URL with search parameters
            const url = new URL('https://api.search.brave.com/res/v1/web/search');
            url.searchParams.append('q', query);
            url.searchParams.append('count', '5');
            url.searchParams.append('search_lang', 'en');
            
            console.debug(`Making request to: ${url.toString()}`);
            console.debug(`Using API key: ${braveApiKey.substring(0, 4)}...`);
            
            const response = await fetch(url, {
              method: 'GET',
              headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': braveApiKey,
              },
            });
            
            console.debug(`Response status: ${response.status}`);
            
            if (!response.ok) {
              const errorText = await response.text();
              console.error(`Brave Search API error response: ${errorText}`);
              throw new Error(`Brave Search API returned status: ${response.status}, message: ${errorText}`);
            }
            
            const data = await response.json();
            console.debug('Search response received successfully');
            
            // Format the search results
            let results = `Here are the search results for "${query}":\n\n`;
            
            if (data.web && data.web.results && data.web.results.length > 0) {
              data.web.results.forEach((result: any, index: number) => {
                results += `${index + 1}. ${result.title}\n`;
                results += `   URL: ${result.url}\n`;
                results += `   Description: ${result.description}\n\n`;
              });
            } else {
              results += "No results found for this query.";
            }
            
            return results;
          } catch (error: unknown) {
            console.error('Error searching the web:', error);
            return `Error searching the web: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
        },
      },
      getRoomTemperatures: {
        description: 'Get the current temperature of all rooms in the house',
        parameters: z.object({}),
        execute: async () => {
          console.debug('executing get room temperatures function');
          try {
            const data = await readRoomsData();
            let response = 'Current room temperatures:\n\n';
            
            data.house.rooms.forEach(room => {
              response += `${room.name}: ${room.temperature}°C\n`;
            });
            
            return response;
          } catch (error: unknown) {
            console.error('Error getting room temperatures:', error);
            return `Error getting room temperatures: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
        },
      },
      setRoomTemperature: {
        description: 'Set the temperature for a specific room in the house',
        parameters: z.object({
          roomName: z.string().describe('The name of the room to set the temperature for'),
          temperature: z.number().describe('The temperature to set in Celsius'),
        }),
        execute: async ({ roomName, temperature }) => {
          console.debug(`executing set room temperature function for ${roomName} to ${temperature}°C`);
          try {
            const data = await readRoomsData();
            
            const room = data.house.rooms.find(r => 
              r.name.toLowerCase() === roomName.toLowerCase()
            );
            
            if (!room) {
              return `Room "${roomName}" not found. Available rooms are: ${data.house.rooms.map(r => r.name).join(', ')}`;
            }
            
            // Store the previous temperature for the response
            const previousTemp = room.temperature;
            
            // Update the temperature
            room.temperature = temperature;
            
            // Write the updated data back to the file
            await writeRoomsData(data);
            
            return `Temperature in ${room.name} has been changed from ${previousTemp}°C to ${temperature}°C.`;
          } catch (error: unknown) {
            console.error('Error setting room temperature:', error);
            return `Error setting room temperature: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
        },
      },
    };
    const agent = new multimodal.MultimodalAgent({ model, fncCtx });
    const session = await agent
      .start(ctx.room, participant)
      .then((session) => session as openai.realtime.RealtimeSession);

    session.conversation.item.create(llm.ChatMessage.create({
      role: llm.ChatRole.ASSISTANT,
      text: 'How can I help you today? I can provide weather information, search the web for you, and control your home temperatures.',
    }));

    session.response.create();
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) })); 