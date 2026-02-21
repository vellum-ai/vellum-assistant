import { useRef, useState, type ReactElement } from "react";
import chalk from "chalk";
import { Text, useInput } from "ink";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
  placeholder?: string;
}

function TextInput({
  value,
  onChange,
  onSubmit,
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
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
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

      if (key.leftArrow) {
        nextOffset = Math.max(0, currentOffset - 1);
      } else if (key.rightArrow) {
        nextOffset = Math.min(currentValue.length, currentOffset + 1);
      } else if (key.backspace || key.delete) {
        if (currentOffset > 0) {
          nextValue = currentValue.slice(0, currentOffset - 1) + currentValue.slice(currentOffset);
          nextOffset = currentOffset - 1;
        }
      } else {
        nextValue =
          currentValue.slice(0, currentOffset) + input + currentValue.slice(currentOffset);
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
      {placeholder ? (value.length > 0 ? renderedValue : renderedPlaceholder) : renderedValue}
    </Text>
  );
}

export default TextInput;
