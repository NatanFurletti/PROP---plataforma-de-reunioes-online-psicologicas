import React from "react";

export const SessionEnded: React.FC = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-800">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md text-center">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center">
            <svg
              className="w-8 h-8 text-blue-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>

        <h1 className="text-2xl font-bold mb-2">Sessão encerrada</h1>
        <p className="text-gray-600 mb-2">
          A sessão foi encerrada pelo psicólogo.
        </p>
        <p className="text-gray-500 text-sm mb-6">
          Obrigado por participar. Cuide-se!
        </p>

        <button
          onClick={() => window.close()}
          className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-6 rounded"
          aria-label="Fechar aba"
        >
          Fechar aba
        </button>
      </div>
    </div>
  );
};
