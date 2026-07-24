type Company = {
  id?: string | null;
  domainName?: {
    primaryLinkUrl?: string | null;
  } | null;
};

type Input = {
  domain?: string | null;
  companies?: Company[] | null;
};

function normalizeDomain(value: string | null | undefined): string {
  const candidate = value?.trim().toLowerCase() ?? "";
  if (!candidate) return "";

  try {
    const url = new URL(
      candidate.includes("://") ? candidate : `https://${candidate}`,
    );
    return url.hostname.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return candidate
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  }
}

export async function main({ domain, companies }: Input) {
  const targetDomain = normalizeDomain(domain);
  const match = (companies ?? []).find(
    (company) =>
      normalizeDomain(company.domainName?.primaryLinkUrl) === targetDomain,
  );

  return {
    hasMatch: Boolean(targetDomain && match?.id),
    companyId: match?.id ?? "",
  };
}
