"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

interface Stage {
  step: string;
  label: string;
  capability: string;
}

const STAGES: Stage[] = [
  { step: 'naming', label: 'Generating assistant name...', capability: '✨ Identity' },
  { step: 'database', label: 'Creating assistant record...', capability: '💾 Memory' },
  { step: 'editor', label: 'Setting up editor...', capability: '📝 Editor' },
  { step: 'upload', label: 'Uploading assistant files...', capability: '📦 Knowledge' },
  { step: 'compute', label: 'Creating compute instance...', capability: '🧠 Intelligence' },
  { step: 'email', label: 'Setting up assistant email...', capability: '📧 Communication' },
];

export function FocusView() {
  const [currentLabel, setCurrentLabel] = useState('Preparing your assistant...');
  const [completedCapabilities, setCompletedCapabilities] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { username } = useAuth();

  useEffect(() => {
    const createAssistant = async () => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (username) {
          headers['x-username'] = username;
        }

        const response = await fetch('/api/assistants', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });

        if (!response.ok) {
          throw new Error('Failed to create assistant');
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response stream');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const seenCapabilities = new Set<string>();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              // Event type not needed for now
              continue;
            }
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                
                if (data.step) {
                  // Find the stage and update UI
                  const stage = STAGES.find(s => s.step === data.step);
                  if (stage) {
                    setCurrentLabel(data.message || stage.label);
                    
                    // Add capability for previous stages
                    const stageIndex = STAGES.findIndex(s => s.step === data.step);
                    for (let i = 0; i < stageIndex; i++) {
                      const cap = STAGES[i].capability;
                      if (!seenCapabilities.has(cap)) {
                        seenCapabilities.add(cap);
                        setCompletedCapabilities(prev => [...prev, cap]);
                      }
                    }
                  }
                }

                if (data.assistant) {
                  // Add all remaining capabilities
                  for (const stage of STAGES) {
                    if (!seenCapabilities.has(stage.capability)) {
                      seenCapabilities.add(stage.capability);
                      setCompletedCapabilities(prev => [...prev, stage.capability]);
                    }
                  }
                }

                if (data.message && data.message.includes('error')) {
                  console.error('Agent creation error:', data.message);
                }
              } catch {
                // Ignore JSON parse errors for incomplete data
              }
            }
          }
        }

        // Brief pause to show completion
        setCurrentLabel('Your assistant is ready!');
        await new Promise(resolve => setTimeout(resolve, 1500));

        router.push('/assistant');

      } catch (err) {
        console.error('Assistant creation failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to create assistant');
      }
    };

    createAssistant();
  }, [router, username]);

  return (
    <div 
      className="min-h-screen w-full flex flex-col items-center justify-center p-4 relative overflow-hidden"
      style={{
        background: 'linear-gradient(135deg, #4facfe 0%, #667eea 20%, #764ba2 40%, #f093fb 60%, #f5576c 80%, #4facfe 100%)',
        backgroundSize: '400% 400%',
        animation: 'gradientShift 12s ease infinite',
      }}
    >
      {/* Blur overlays for mesh effect */}
      <div 
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at 20% 30%, rgba(79, 172, 254, 0.5) 0%, transparent 50%), radial-gradient(ellipse at 80% 70%, rgba(245, 87, 108, 0.5) 0%, transparent 50%), radial-gradient(ellipse at 50% 50%, rgba(118, 75, 162, 0.3) 0%, transparent 60%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center">
        {/* Hatching header */}
        <h1 className="text-3xl md:text-4xl font-semibold text-white mb-12 drop-shadow-lg">
          Hatching... 🐣
        </h1>

        {/* Error state */}
        {error ? (
          <div className="bg-red-500/20 backdrop-blur-sm rounded-lg px-6 py-4 text-white">
            <p className="font-medium">Something went wrong</p>
            <p className="text-sm text-white/80 mt-1">{error}</p>
            <button 
              onClick={() => router.push('/assistant')}
              className="mt-4 px-4 py-2 bg-white/20 rounded-lg text-sm hover:bg-white/30 transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        ) : (
          <>
            {/* Current stage with spinner */}
            <div className="flex items-center gap-3 text-white/90 mb-8">
              <svg 
                className="animate-spin h-5 w-5" 
                xmlns="http://www.w3.org/2000/svg" 
                fill="none" 
                viewBox="0 0 24 24"
              >
                <circle 
                  className="opacity-25" 
                  cx="12" 
                  cy="12" 
                  r="10" 
                  stroke="currentColor" 
                  strokeWidth="4"
                />
                <path 
                  className="opacity-75" 
                  fill="currentColor" 
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span className="text-lg">
                {currentLabel}
              </span>
            </div>

            {/* Completed capabilities */}
            {completedCapabilities.length > 0 && (
              <div className="mt-4 flex flex-col items-center gap-2">
                <p className="text-white/60 text-sm mb-2">
                  Capabilities acquired:
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  {completedCapabilities.map((capability, index) => (
                    <div
                      key={index}
                      className="bg-white/20 backdrop-blur-sm rounded-full px-4 py-2 text-white text-sm font-medium"
                      style={{
                        animation: 'fadeIn 0.5s ease-out forwards',
                      }}
                    >
                      {capability}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Keyframes */}
      <style jsx>{`
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes fadeIn {
          from { 
            opacity: 0; 
            transform: translateY(10px); 
          }
          to { 
            opacity: 1; 
            transform: translateY(0); 
          }
        }
      `}</style>
    </div>
  );
}
