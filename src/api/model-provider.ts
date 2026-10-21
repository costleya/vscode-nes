// One dispatch point for supported prompt/response protocols. Server model
// aliases remain independent so local servers can choose their own model IDs.
import { detectModelFormat, type ModelFormat } from "./model-format.ts";
import { buildZeta2Response } from "./zeta2-completion.ts";
import { buildZeta2Prompt, selectZetaCursorWindowFromLineProvider } from "./zeta2-prompt.ts";

const MODEL_PROVIDERS = {
  "zeta2.1": {
    buildPrompt: buildZeta2Prompt,
    buildResponse: buildZeta2Response,
    selectCursorWindow: selectZetaCursorWindowFromLineProvider,
  },
} satisfies Record<ModelFormat, unknown>;

export function getModelProvider(modelName: string) {
  return MODEL_PROVIDERS[detectModelFormat(modelName)];
}
