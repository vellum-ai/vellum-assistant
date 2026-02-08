import React, { useState } from 'react';
import { Bot, Zap, Sparkles, Code, Brain, Target } from 'lucide-react';

// Types for onboarding steps and user preferences
type OnboardingStep = 
  | 'welcome'
  | 'use_case'
  | 'experience_level'
  | 'template_selection'
  | 'agent_customization'
  | 'complete';

type UseCase = 
  | 'personal_assistant'
  | 'coding_helper'
  | 'research_tool'
  | 'business_automation'
  | 'creative_writing'
  | 'other';

type ExperienceLevel = 
  | 'beginner'
  | 'intermediate'
  | 'advanced';

interface OnboardingState {
  useCase: UseCase | null;
  experienceLevel: ExperienceLevel | null;
  selectedTemplate: string | null;
}

export function OnboardingWizard() {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>('welcome');
  // State for tracking user selections (to be used for personalization)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [onboardingState, setOnboardingState] = useState<OnboardingState>({
    useCase: null,
    experienceLevel: null,
    selectedTemplate: null
  });

  const handleUseCaseSelect = (useCase: UseCase) => {
    setOnboardingState(prev => ({ ...prev, useCase }));
    setCurrentStep('experience_level');
  };

  const handleExperienceLevelSelect = (level: ExperienceLevel) => {
    setOnboardingState(prev => ({ ...prev, experienceLevel: level }));
    setCurrentStep('template_selection');
  };

  const handleTemplateSelect = (template: string) => {
    setOnboardingState(prev => ({ ...prev, selectedTemplate: template }));
    setCurrentStep('agent_customization');
  };

  const renderStep = () => {
    switch (currentStep) {
      case 'welcome':
        return (
          <div className="text-center">
            <h2 className="text-3xl font-bold mb-4">Welcome to Velly</h2>
            <p className="text-zinc-600 mb-6">Let&apos;s create your first AI agent together</p>
            <button 
              onClick={() => setCurrentStep('use_case')}
              className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700"
            >
              Get Started <Zap className="inline-block ml-2" />
            </button>
          </div>
        );

      case 'use_case':
        return (
          <div>
            <h3 className="text-2xl font-semibold mb-4">What do you want to build?</h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { value: 'personal_assistant', label: 'Personal Assistant', icon: Bot },
                { value: 'coding_helper', label: 'Coding Helper', icon: Code },
                { value: 'research_tool', label: 'Research Tool', icon: Brain },
                { value: 'business_automation', label: 'Business Automation', icon: Target },
                { value: 'creative_writing', label: 'Creative Writing', icon: Sparkles },
                { value: 'other', label: 'Something Else', icon: Zap }
              ].map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => handleUseCaseSelect(value as UseCase)}
                  className="border rounded-lg p-4 hover:bg-zinc-100 flex items-center gap-4"
                >
                  <Icon className="w-6 h-6 text-indigo-600" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        );

      case 'experience_level':
        return (
          <div>
            <h3 className="text-2xl font-semibold mb-4">Your AI Agent Experience</h3>
            <div className="grid grid-cols-3 gap-4">
              {[
                { value: 'beginner', label: 'Beginner', description: 'Just getting started' },
                { value: 'intermediate', label: 'Intermediate', description: 'Some AI experience' },
                { value: 'advanced', label: 'Advanced', description: 'AI expert' }
              ].map(({ value, label, description }) => (
                <button
                  key={value}
                  onClick={() => handleExperienceLevelSelect(value as ExperienceLevel)}
                  className="border rounded-lg p-4 hover:bg-zinc-100"
                >
                  <h4 className="font-semibold">{label}</h4>
                  <p className="text-sm text-zinc-500">{description}</p>
                </button>
              ))}
            </div>
          </div>
        );

      case 'template_selection':
        return (
          <div>
            <h3 className="text-2xl font-semibold mb-4">Choose an Agent Template</h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { 
                  value: 'simple', 
                  label: 'Simple Agent', 
                  description: 'Basic, flexible agent for various tasks',
                  icon: Bot 
                },
                { 
                  value: 'openclaw', 
                  label: 'OpenClaw Agent', 
                  description: 'Advanced, modular agent with rich capabilities',
                  icon: Zap 
                }
              ].map(({ value, label, description, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => handleTemplateSelect(value)}
                  className="border rounded-lg p-4 hover:bg-zinc-100 flex items-center gap-4"
                >
                  <Icon className="w-6 h-6 text-indigo-600" />
                  <div className="text-left">
                    <h4 className="font-semibold">{label}</h4>
                    <p className="text-sm text-zinc-500">{description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );

      case 'agent_customization':
        return (
          <div>
            <h3 className="text-2xl font-semibold mb-4">Name Your Agent</h3>
            <input 
              type="text" 
              placeholder="Enter your agent's name" 
              className="w-full border rounded-lg p-3"
            />
            <button 
              onClick={() => setCurrentStep('complete')}
              className="mt-4 bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700"
            >
              Create Agent
            </button>
          </div>
        );

      case 'complete':
        return (
          <div className="text-center">
            <h2 className="text-3xl font-bold mb-4">Agent Created Successfully!</h2>
            <p className="text-zinc-600 mb-6">Your agent is ready to help you</p>
            <button 
              onClick={() => {/* Redirect to agents page */}}
              className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700"
            >
              Go to My Agents
            </button>
          </div>
        );
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-8 bg-white rounded-xl shadow-lg">
      {renderStep()}
    </div>
  );
}