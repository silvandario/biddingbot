'use client';

import { useState, useRef, useEffect } from 'react';

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const noMessages = messages.length === 0;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleInputChange = (e) => {
    setInput(e.target.value);
  };

  // Updated handleSubmit function for your frontend
const handleSubmit = async (e) => {
  e.preventDefault();

  if (!input.trim()) return;

  const userMessage = { id: Date.now(), role: 'user', content: input };
  setMessages(prev => [...prev, userMessage]);
  setInput('');
  setIsLoading(true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [...messages.map(m => ({ role: m.role, content: m.content })), 
                  { role: 'user', content: input }]
      }),
    });

    if (!res.ok) throw new Error('Network response failed');

    // Add the assistant message with empty content first
    const assistantMessageId = Date.now() + 1;
    setMessages(prev => [...prev, { id: assistantMessageId, role: 'assistant', content: '' }]);
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      // Parse the AI SDK format
      const textChunks = chunk.split('\n').filter(Boolean).map(line => {
        // Extract just the text portion after the number and colon
        const match = line.match(/^\d+:"(.+?)"/);
        if (match && match[1]) {
          return match[1];
        }
        return '';
      }).join('');
      
      accumulatedText += textChunks;
      
      // Update the assistant message with accumulated text
      setMessages(prev => 
        prev.map(msg => 
          msg.id === assistantMessageId 
            ? { ...msg, content: accumulatedText } 
            : msg
        )
      );
    }
  } catch (err) {
    console.error('Error:', err);
    setMessages(prev => [...prev, {
      id: Date.now() + 2,
      role: 'assistant',
      content: 'Sorry, I had trouble generating a response. Please try again.'
    }]);
  } finally {
    setIsLoading(false);
    inputRef.current?.focus();
  }
};

  const useSuggestion = (text) => {
    setInput(text);
    inputRef.current?.focus();
  };

  return (
    <div className="min-h-screen flex flex-col font-sans">
      <main className="flex-1 container max-w-5xl mx-auto px-4 py-6 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto mb-6 space-y-6 pr-1 scroll-smooth">
          {noMessages ? (
            <div className="text-center py-10">
              <h2 className="text-2xl font-bold mb-4">Welcome to Bidding Bro!</h2>
              <p className="text-gray-600 mb-6">Ask me anything about the HSG bidding system or Master programs.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg mx-auto">
                {[
                  'How many IS/FPV credits do I need for MBI?',
                  "Is there a course that demonstrates how to make money from data?",
                  'Suggest a course about the environment with four credits.',
                  'Is Arne really the best teacher?'
                ].map((suggestion) => (
                  <button key={suggestion} onClick={() => useSuggestion(suggestion)} className="bg-slate-100 dark:bg-slate-700 text-sm p-3 rounded-xl hover:bg-slate-200">
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-md px-5 py-3 rounded-2xl shadow ${message.role === 'user' ? 'bg-blue-500 text-white rounded-tr-none' : 'bg-white dark:bg-slate-800 rounded-tl-none'}`}>
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                </div>
              </div>
            ))
          )}
          {isLoading && (
            <div className="flex items-center space-x-2 text-sm text-gray-400">Typing<span className="animate-pulse">...</span></div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit} className="relative z-10">
          <div className="relative">
            <input
              ref={inputRef}
              className="w-full bg-white dark:bg-slate-800 border rounded-full pl-5 pr-14 py-4 shadow focus:outline-none"
              type="text"
              placeholder="Ask about HSG bidding and courses..."
              value={input}
              onChange={handleInputChange}
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 bg-blue-600 text-white px-4 py-2 rounded-full"
            >
              Send
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
