import React, { useState } from 'react';
import { Sparkles, Wand, Zap, ArrowRight } from 'lucide-react';

export function WelcomeScreen() {
  const [email, setEmail] = useState('');
  const [isAnimating, setIsAnimating] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsAnimating(true);
    // TODO: Add actual email validation and next step logic
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-indigo-50 to-white dark:from-zinc-900 dark:to-zinc-800 p-4">
      <div className={`
        max-w-md w-full 
        bg-white dark:bg-zinc-900 
        rounded-2xl 
        shadow-2xl 
        border border-zinc-100 dark:border-zinc-800
        p-8 
        transition-all duration-700
        ${isAnimating ? 'scale-105 opacity-50' : 'scale-100 opacity-100'}
      `}>
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <div className="bg-indigo-100 dark:bg-indigo-900/30 p-3 rounded-full">
              <Sparkles className="w-8 h-8 text-indigo-600 dark:text-indigo-400 animate-pulse" />
            </div>
          </div>
          
          <h1 className="text-3xl font-bold mb-4 text-zinc-900 dark:text-white">
            Create Your <span className="text-indigo-600 dark:text-indigo-400">Personal AI Assistant</span>
          </h1>
          
          <p className="text-zinc-600 dark:text-zinc-400 mb-6">
            An AI companion that's uniquely yours — intelligent, helpful, and always learning.
          </p>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <input 
              type="email" 
              placeholder="Enter your email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="
                w-full 
                px-4 py-3 
                border border-zinc-200 dark:border-zinc-700 
                rounded-lg 
                focus:outline-none 
                focus:ring-2 focus:ring-indigo-500
                transition-all
                bg-white dark:bg-zinc-800
                text-zinc-900 dark:text-white
                placeholder-zinc-400 dark:placeholder-zinc-500
              "
            />
            
            <button 
              type="submit"
              disabled={!email}
              className="
                w-full 
                bg-indigo-600 
                text-white 
                py-3 
                rounded-lg 
                hover:bg-indigo-700 
                transition-colors
                flex 
                items-center 
                justify-center 
                gap-2
                disabled:opacity-50
                disabled:cursor-not-allowed
              "
            >
              {isAnimating ? (
                <>
                  <Wand className="w-5 h-5 animate-spin" />
                  Creating Your Assistant
                </>
              ) : (
                <>
                  <ArrowRight className="w-5 h-5" />
                  Get Started
                </>
              )}
            </button>
          </form>
          
          <div className="mt-6 text-xs text-zinc-500 dark:text-zinc-600 flex items-center justify-center gap-2">
            <Zap className="w-4 h-4 text-yellow-500" />
            No credit card required. Your AI, your way.
          </div>
        </div>
      </div>
      
      {/* Subtle background animations */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-[-1]">
        <div className="absolute top-0 right-0 w-72 h-72 bg-indigo-100 dark:bg-indigo-900/20 rounded-full blur-3xl opacity-30 animate-blob"></div>
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-purple-100 dark:bg-purple-900/20 rounded-full blur-3xl opacity-20 animate-blob animation-delay-2000"></div>
      </div>
    </div>
  );
}