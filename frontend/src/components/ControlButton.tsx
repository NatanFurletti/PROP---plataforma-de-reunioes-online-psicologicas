import React from "react";

interface ControlButtonProps {
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "secondary";
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export const ControlButton: React.FC<ControlButtonProps> = ({
  onClick,
  disabled = false,
  variant = "primary",
  icon,
  children,
}) => {
  const variantClasses = {
    primary: "bg-blue-600 hover:bg-blue-700",
    danger: "bg-red-600 hover:bg-red-700",
    secondary: "bg-gray-600 hover:bg-gray-700",
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        p-3 rounded-full flex items-center justify-center gap-2
        text-white font-semibold transition-all
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantClasses[variant]}
      `}
    >
      {icon}
      {children}
    </button>
  );
};
