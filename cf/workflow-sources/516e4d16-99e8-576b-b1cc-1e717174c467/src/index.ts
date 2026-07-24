type Input = {
  email?: string | null;
};

export async function main({ email }: Input) {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  const separatorIndex = normalizedEmail.lastIndexOf("@");
  const domain =
    separatorIndex >= 0
      ? normalizedEmail
          .slice(separatorIndex + 1)
          .replace(/^\.+|\.+$/g, "")
          .replace(/^www\./, "")
      : "";

  return {
    domain,
    url: domain ? `https://${domain}` : "",
  };
}
