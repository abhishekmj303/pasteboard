import {
  createElement, ArrowLeft, Bold, Check, Code, Copy, Download, ExternalLink, Eye, File as FileIcon, FileText, Heading1, Heading2,
  Hash, Image as ImageIcon, Italic, Link as LinkIcon, List, Menu, Plus, ListOrdered, ListTodo, LogOut, Minus, Paperclip, Pencil, Pin, PinOff,
  Quote, Redo2, Save, Search, SendHorizontal, SquareCode, Strikethrough, Trash2, Type, Undo2, Unlink, X,
} from 'lucide';

const set = {
  back: ArrowLeft, bold: Bold, check: Check, code: Code, copy: Copy, download: Download, open: ExternalLink, view: Eye, file: FileIcon,
  page: FileText, h1: Heading1, h2: Heading2, lines: Hash, image: ImageIcon, italic: Italic, link: LinkIcon, bullets: List,
  numbers: ListOrdered, tasks: ListTodo, logout: LogOut, divider: Minus, attach: Paperclip, edit: Pencil, pin: Pin, unpin: PinOff,
  quote: Quote, redo: Redo2, save: Save, search: Search, send: SendHorizontal, codeblock: SquareCode, strike: Strikethrough,
  trash: Trash2, menu: Menu, plus: Plus, format: Type, undo: Undo2, unlink: Unlink, close: X,
};

export const icon = (name, size = 18) => createElement(set[name], { width: size, height: size, 'stroke-width': 2, 'aria-hidden': 'true' });

// <button data-icon="save">Save</button> → icon prepended to the label
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.prepend(icon(el.dataset.icon));
    el.removeAttribute('data-icon');
  }
}
