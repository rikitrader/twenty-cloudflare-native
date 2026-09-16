import{t as e}from"./lib-C3IpGLsk.js";var o=e`
  query GetAdminAiModels {
    getAdminAiModels {
      defaultModelByTier {
        tier
        modelId
      }
      models {
        modelId
        label
        modelFamily
        sdkPackage
        isAvailable
        isAdminEnabled
        isDeprecated
        contextWindowTokens
        maxOutputTokens
        inputCostPerMillionTokens
        outputCostPerMillionTokens
        providerName
        providerLabel
        name
        dataResidency
        efforts
      }
    }
  }
`,d=e`
  query GetAiProviders {
    getAiProviders
  }
`;export{o as n,d as t};
