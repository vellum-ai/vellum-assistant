/** Value of `--flag value` or `--flag=value` from argv. */
export const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return (
    inline?.slice(flag.length + 1) ??
    (index >= 0 ? process.argv[index + 1] : undefined)
  );
};
