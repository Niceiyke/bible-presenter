import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Underline } from '@tiptap/extension-underline';
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { 
  Bold, Italic, Underline as UnderlineIcon, 
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Type
} from 'lucide-react';

interface TiptapEditorProps {
  content: string;
  onChange: (html: string) => void;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  textAlign?: string;
}

export function TiptapEditor({ content, onChange, fontFamily, fontSize, color, textAlign }: TiptapEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
    ],
    content: content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: 'prose prose-invert focus:outline-none max-w-none min-h-[100px] p-2 text-sm',
      },
      // Stop ALL keydown events from reaching parent window handlers.
      // This fixes spacebar, delete, and other keys being intercepted.
      handleDOMEvents: {
        keydown: (_view, event) => {
          event.stopPropagation();
          return false; // let Tiptap/ProseMirror handle the key normally
        },
      },
    },
  });

  // Sync content if it changes externally (and it's not what we just emitted)
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  if (!editor) return null;

  return (
    <div className="flex flex-col border border-slate-700 rounded-md overflow-hidden bg-slate-950">
      <div className="flex flex-wrap items-center gap-0.5 p-1 bg-slate-900 border-b border-slate-700">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`p-1.5 rounded transition-all ${editor.isActive('bold') ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Bold"
        >
          <Bold size={14} />
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`p-1.5 rounded transition-all ${editor.isActive('italic') ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Italic"
        >
          <Italic size={14} />
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`p-1.5 rounded transition-all ${editor.isActive('underline') ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Underline"
        >
          <UnderlineIcon size={14} />
        </button>
        
        <div className="w-px h-4 bg-slate-700 mx-1" />

        <button
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          className={`p-1.5 rounded transition-all ${editor.isActive({ textAlign: 'left' }) ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Align Left"
        >
          <AlignLeft size={14} />
        </button>
        <button
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          className={`p-1.5 rounded transition-all ${editor.isActive({ textAlign: 'center' }) ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Align Center"
        >
          <AlignCenter size={14} />
        </button>
        <button
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          className={`p-1.5 rounded transition-all ${editor.isActive({ textAlign: 'right' }) ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Align Right"
        >
          <AlignRight size={14} />
        </button>
        <button
          onClick={() => editor.chain().focus().setTextAlign('justify').run()}
          className={`p-1.5 rounded transition-all ${editor.isActive({ textAlign: 'justify' }) ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Justify"
        >
          <AlignJustify size={14} />
        </button>

        <div className="w-px h-4 bg-slate-700 mx-1" />

        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={`p-1.5 rounded transition-all ${editor.isActive('heading', { level: 1 }) ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Heading 1"
        >
          <span className="text-[10px] font-black">H1</span>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`p-1.5 rounded transition-all ${editor.isActive('heading', { level: 2 }) ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Heading 2"
        >
          <span className="text-[10px] font-black">H2</span>
        </button>
      </div>
      <EditorContent 
        editor={editor} 
        className="tiptap-editor-content"
        style={{ 
          fontFamily: fontFamily || 'inherit',
          fontSize: fontSize ? `${fontSize}px` : 'inherit',
          color: color || 'inherit'
        }}
      />
    </div>
  );
}
