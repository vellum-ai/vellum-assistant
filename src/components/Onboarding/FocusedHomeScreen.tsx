import React, { useState } from 'react';

export function FocusedHomeScreen() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="text-center">
        {!isSubmitting ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input 
              type="email" 
              placeholder="Email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 border rounded-lg"
            />
            <button 
              type="submit"
              disabled={!email}
              className="w-full bg-black text-white py-3 rounded-lg"
            >
              Continue
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="animate-pulse h-2 bg-gray-300 rounded w-64 mx-auto"></div>
            <div className="animate-pulse h-2 bg-gray-300 rounded w-48 mx-auto"></div>
            <div className="animate-pulse h-2 bg-gray-300 rounded w-56 mx-auto"></div>
          </div>
        )}
      </div>
    </div>
  );
}