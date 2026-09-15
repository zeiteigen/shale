import { getSDK, type ShaleSDK } from "@shale/sdk";
import { setup } from "./setup";
import {
  canProcessImage,
  describeImageWithChatModel,
  parseImageFile,
  processImageFile,
  DEFAULT_IMAGE_EXTENSIONS,
  type ParsedImageInfo,
} from "./process-image";

export {
  setup,
  canProcessImage,
  describeImageWithChatModel,
  parseImageFile,
  processImageFile,
  DEFAULT_IMAGE_EXTENSIONS,
  type ParsedImageInfo,
};

/**
 * Default entrypoint if executed directly.
 */
export async function run(sdkOverride?: ShaleSDK): Promise<void> {
  const sdk = sdkOverride ?? getSDK();
  await setup(sdk);
}

export default run;
