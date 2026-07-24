type Input = {
  primaryEmail?: string | null;
};

const PERSONAL_EMAIL_DOMAINS = new Set([
  "aol.com",
  "icloud.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  "ymail.com",
]);

export async function main({ primaryEmail }: Input) {
  const normalizedEmail = primaryEmail?.trim().toLowerCase() ?? "";
  const separatorIndex = normalizedEmail.lastIndexOf("@");
  const domain =
    separatorIndex >= 0 ? normalizedEmail.slice(separatorIndex + 1) : "";

  return {
    isPersonal: PERSONAL_EMAIL_DOMAINS.has(domain),
  };
}
