import { styled } from "../setup.js";
import { theme } from "../styles/theme.js";
import type { ComponentChildren, JSX } from "preact";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBack?: () => void;
  showBack?: boolean;
  title?: string;
  children: ComponentChildren;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizeMap: Record<string, string> = {
  sm: "400px",
  md: "600px",
  lg: "800px",
  xl: "1000px",
};

interface OverlayProps {
  $isOpen: boolean;
}

const Overlay = styled("div")<OverlayProps>`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: ${(p) => (p.$isOpen ? "flex" : "none")};
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: ${theme.spacing.lg};
`;

interface ModalContainerProps {
  $size: string;
}

const ModalContainer = styled("div")<ModalContainerProps>`
  background: ${theme.colors.background};
  border-radius: ${theme.borderRadius.xl};
  box-shadow: ${theme.shadow.xl};
  max-width: ${(p) => p.$size};
  width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const ModalHeader = styled("div")`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${theme.spacing.md} ${theme.spacing.lg};
  border-bottom: 1px solid ${theme.colors.border};
`;

const ModalTitle = styled("h3")`
  display: flex;
  align-items: center;
  gap: ${theme.spacing.sm};
  font-size: ${theme.fontSize.lg};
  font-weight: ${theme.fontWeight.semibold};
  margin: 0;
`;

const BackButton = styled("button")`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: ${theme.fontSize.sm};
  color: ${theme.colors.textMuted};
  background: none;
  border: none;
  cursor: pointer;
  border-radius: ${theme.borderRadius.sm};
  
  &:hover {
    background: ${theme.colors.backgroundHover};
    color: ${theme.colors.text};
  }
`;

const CloseButton = styled("button")`
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: ${theme.fontSize.xl};
  color: ${theme.colors.textMuted};
  background: none;
  border: none;
  cursor: pointer;
  border-radius: ${theme.borderRadius.sm};
  
  &:hover {
    background: ${theme.colors.backgroundHover};
    color: ${theme.colors.text};
  }
`;

const ModalBody = styled("div")`
  padding: ${theme.spacing.lg};
  overflow-y: auto;
  flex: 1;
`;

export function Modal({
  isOpen,
  onClose,
  onBack,
  showBack = false,
  title,
  children,
  size = "md",
}: ModalProps) {
  const handleOverlayClick = (e: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      if (showBack && onBack) {
        onBack();
      } else {
        onClose();
      }
    }
  };

  return (
    <Overlay $isOpen={isOpen} onClick={handleOverlayClick}>
      <ModalContainer $size={sizeMap[size]} onClick={(e: Event) => e.stopPropagation()}>
        {title && (
          <ModalHeader>
            <ModalTitle>
              {showBack && onBack && (
                <BackButton onClick={onBack}>← Back</BackButton>
              )}
              {title}
            </ModalTitle>
            <CloseButton onClick={onClose}>×</CloseButton>
          </ModalHeader>
        )}
        <ModalBody>{children}</ModalBody>
      </ModalContainer>
    </Overlay>
  );
}

// Modal sections
export const ModalSection = styled("div")`
  margin-bottom: ${theme.spacing.lg};
  
  &:last-child {
    margin-bottom: 0;
  }
`;

export const ModalSectionTitle = styled("h4")`
  font-size: ${theme.fontSize.md};
  font-weight: ${theme.fontWeight.semibold};
  color: ${theme.colors.text};
  margin-bottom: ${theme.spacing.sm};
`;
