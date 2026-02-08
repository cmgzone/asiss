import fs from 'fs';
import path from 'path';
import { Skill } from '../core/skills';

export class NotesSkill implements Skill {
  name = 'notes';
  description = 'Manage persistent notes. Actions: add_note (content), read_notes, clear_notes';
  
  // Define input schema for LLM tool usage
  inputSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add_note", "read_notes", "clear_notes"],
        description: "The action to perform on notes"
      },
      content: {
        type: "string",
        description: "The content to add (only for add_note action)"
      }
    },
    required: ["action"]
  };

  private filePath: string;

  constructor() {
    this.filePath = path.join(process.cwd(), 'notes.md');
  }

  async execute(params: any): Promise<any> {
    const { action, content } = params;

    try {
      if (action === 'add_note') {
        if (!content) return { error: 'Content is required for add_note' };
        
        const timestamp = new Date().toISOString();
        const noteEntry = `\n## [${timestamp}]\n${content}\n`;
        
        fs.appendFileSync(this.filePath, noteEntry);
        return { success: true, message: 'Note added successfully' };
      }

      if (action === 'read_notes') {
        if (fs.existsSync(this.filePath)) {
          const notes = fs.readFileSync(this.filePath, 'utf-8');
          return { notes: notes || '(No notes yet)' };
        }
        return { notes: '(No notes yet)' };
      }

      if (action === 'clear_notes') {
        fs.writeFileSync(this.filePath, '# My Notes\n');
        return { success: true, message: 'Notes cleared' };
      }

      return { error: `Unknown action: ${action}` };

    } catch (err: any) {
      return { error: `Failed to perform ${action}: ${err.message}` };
    }
  }
}
