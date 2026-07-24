import { describe, expect, it } from "vitest";
import { main as extractDomain } from "../cf/workflow-sources/516e4d16-99e8-576b-b1cc-1e717174c467/src/index";
import { main as findCompany } from "../cf/workflow-sources/ab9da70e-8736-562d-9fa5-fe74c5047a14/src/index";
import { main as classifyEmail } from "../cf/workflow-sources/8fd85fbc-9457-5f4d-90e4-a9a098567c72/src/index";

describe("workflow source recovery", () => {
  it("classifies personal and business email domains", async () => {
    await expect(
      classifyEmail({ primaryEmail: " Person@Gmail.com " }),
    ).resolves.toEqual({ isPersonal: true });
    await expect(
      classifyEmail({ primaryEmail: "lead@acme.example" }),
    ).resolves.toEqual({ isPersonal: false });
  });

  it("extracts a normalized company domain and URL", async () => {
    await expect(
      extractDomain({ email: " Lead@WWW.Acme.Example. " }),
    ).resolves.toEqual({
      domain: "acme.example",
      url: "https://acme.example",
    });
    await expect(extractDomain({ email: "invalid" })).resolves.toEqual({
      domain: "",
      url: "",
    });
  });

  it("finds companies by normalized website hostname", async () => {
    await expect(
      findCompany({
        domain: "acme.example",
        companies: [
          {
            id: "company-1",
            domainName: { primaryLinkUrl: "https://www.acme.example/about" },
          },
        ],
      }),
    ).resolves.toEqual({ hasMatch: true, companyId: "company-1" });
    await expect(
      findCompany({ domain: "missing.example", companies: [] }),
    ).resolves.toEqual({ hasMatch: false, companyId: "" });
  });
});
