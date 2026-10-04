const matchesAllowedPrefix = (command, prefix) =>
  command === prefix || command.startsWith(`${prefix} `);

const hasAllowedPrefix = (command, allowedPrefixes) =>
  command.length > 0 && allowedPrefixes.some((prefix) => matchesAllowedPrefix(command, prefix));

export const isCommandAllowed = (command, allowedPrefixes) =>
  hasAllowedPrefix(command.trim(), allowedPrefixes);
