import { useRef, useState, type ReactElement } from "react";
import chalk from "chalk";
import { Text, useInput } from "ink";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  focus?: boolean;
  placeholder?: string;
}

function TextInput({
  value,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  focus = true,
  placeholder = "",
}: TextInputProps): ReactElement {
  const cursorOffsetRef = useRef(value.length);
  const valueRef = useRef(value);

  valueRef.current = value;

  if (cursorOffsetRef.current > value.length) {
    cursorOffsetRef.current = value.length;
  }

  const [, setRenderTick] = useState(0);

  useInput(
    (input, key) => {
      if (key.upArrow && !key.shift && !key.meta) {
        onHistoryUp?.();
        cursorOffsetRef.current = Infinity;
        setRenderTick((t) => t + 1);
        return;
      }
      if (key.downArrow && !key.shift && !key.meta) {
        onHistoryDown?.();
        cursorOffsetRef.current = Infinity;
        setRenderTick((t) => t + 1);
        return;
      }
      if ((key.ctrl && input === "c") || key.tab || (key.shift && key.tab)) {
        return;
      }

      if (key.return) {
        onSubmit?.(valueRef.current);
        return;
      }

      const currentValue = valueRef.current;
      const currentOffset = cursorOffsetRef.current;
      let nextValue = currentValue;
      let nextOffset = currentOffset;

      if (key.ctrl && input === "a") {
        // Ctrl+A — move cursor to start
        nextOffset = 0;
      } else if (key.ctrl && input === "e") {
        // Ctrl+E — move cursor to end
        nextOffset = currentValue.length;
      } else if (key.ctrl && input === "u") {
        // Ctrl+U — clear line before cursor
        nextValue = currentValue.slice(currentOffset);
        nextOffset = 0;
      } else if (key.ctrl && input === "k") {
        // Ctrl+K — kill from cursor to end
        nextValue = currentValue.slice(0, currentOffset);
      } else if (key.ctrl && input === "w") {
        // Ctrl+W — delete word backwards (handles tabs and other whitespace)
        const before = currentValue.slice(0, currentOffset);
        // Skip trailing whitespace, then find previous whitespace boundary
        const match = before.match(/^(.*\s)?\S+\s*$/);
        const wordStart = match?.[1]?.length ?? 0;
        nextValue =
          currentValue.slice(0, wordStart) + currentValue.slice(currentOffset);
        nextOffset = wordStart;
      } else if (key.leftArrow) {
        nextOffset = Math.max(0, currentOffset - 1);
      } else if (key.rightArrow) {
        nextOffset = Math.min(currentValue.length, currentOffset + 1);
      } else if (key.backspace || key.delete) {
        if (currentOffset > 0) {
          nextValue =
            currentValue.slice(0, currentOffset - 1) +
            currentValue.slice(currentOffset);
          nextOffset = currentOffset - 1;
        }
      } else {
        nextValue =
          currentValue.slice(0, currentOffset) +
          input +
          currentValue.slice(currentOffset);
        nextOffset = currentOffset + input.length;
      }

      cursorOffsetRef.current = nextOffset;

      if (nextValue !== currentValue) {
        valueRef.current = nextValue;
        onChange(nextValue);
      }

      setRenderTick((t) => t + 1);
    },
    { isActive: focus },
  );

  const cursorOffset = cursorOffsetRef.current;
  let renderedValue: string;
  let renderedPlaceholder: string | undefined;

  if (focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");

    if (value.length > 0) {
      renderedValue = "";
      let i = 0;
      for (const char of value) {
        renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
        i++;
      }
      if (cursorOffset === value.length) {
        renderedValue += chalk.inverse(" ");
      }
    } else {
      renderedValue = chalk.inverse(" ");
    }
  } else {
    renderedValue = value;
    renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;
  }

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}

export default TextInput;
