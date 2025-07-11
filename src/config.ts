import log from "loglevel";
import { ResponseFormat } from "./openai_api_protocols";
import { LogitProcessor, InitProgressCallback, LogLevel } from "./types";
import {
  DependencyError,
  InvalidNumberStringError,
  MinValueError,
  NonNegativeError,
  RangeError,
} from "./error";

export interface ConvTemplateConfig {
    system_template : string;
    system_message: string;
    roles: Record<Role, string>;
    role_templates?: Partial<Record<Role, string>>;
    seps: Array<string>;
    role_content_sep?: string;
    role_empty_sep?: string;
    stop_str: Array<string>;
    system_prefix_token_ids?: Array<number>;
    stop_token_ids: Array<number>;
    add_role_after_system_message?: boolean;
}

export enum Role {
    user = 'user',
    assistant = "assistant",
    tool = "tool",
}
export const DefaultLogLevel: LogLevel = "WARN";

/**
 * Place holders that can be used in role templates.
 * For example, a role template of
 * `<<question>> ${MessagePlaceholders.USER} <<function>> ${MessagePlaceholders.FUNCTION}`
 * will insert the user message to ${MessagePlaceholders.USER}
 * and insert the function message to ${MessagePlaceholders.FUNCTION}
 * at run time.
 */

export enum MessagePlaceholders {
  system = "{system_message}",
  user = "{user_message}",
  assistant = "{assistant_message}",
  tool = "{tool_message}",
  function = "{function_string}",
  hermes_tools = "{hermes_tools}",
}

export interface TokenizerInfo {
    token_posrproc_method: string;
    prepend_space_in_encode: boolean;
    append_space_in_encode: boolean;
}

export interface ChatConfig {
    tokenizer_files: Array<string>;
  tokenizer_info?: TokenizerInfo;
  token_table_postproc_method?: string; // TODO: backward compatibility, remove soon
  vocab_size: number;
  conv_config?: Partial<ConvTemplateConfig>;
  conv_template: ConvTemplateConfig;
  // KVCache settings
  context_window_size: number;
  sliding_window_size: number;
  attention_sink_size: number;
  // Fields below can be swapped per-generation via `GenerationConfig`
  // Fields only used in MLC
  repetition_penalty: number;
  // Fields shared by MLC and OpenAI APIs
  frequency_penalty: number;
  presence_penalty: number;
  top_p: number;
  temperature: number;
  bos_token_id?: number;
}

export interface ChatOptions extends Partial<ChatConfig> {}

export interface MLCEngineConfig {
  appConfig?: AppConfig;
  initProgressCallback?: InitProgressCallback;
  logitProcessorRegistry?: Map<string, LogitProcessor>;
  logLevel?: LogLevel;
}

export interface GenerationConfig {
     repetition_penalty?: number;
  ignore_eos?: boolean;
  // Shared by MLC and OpenAI APIs
  top_p?: number | null;
  temperature?: number | null;
  // Only in OpenAI APIs
  max_tokens?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  stop?: string | null | Array<string>;
  n?: number | null;
  logit_bias?: Record<string, number> | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  response_format?: ResponseFormat | null;
  // extra_body in ChatCompletionsRequest
  enable_thinking?: boolean | null;
}

export function postInitAndCheckGenerationConfigValues(
  config: GenerationConfig,
): void {

    function _hasValue(value : any) : boolean {
        return value !== undefined && value !== null;
    }
    if(
        config.frequency_penalty &&
    (config.frequency_penalty < -2.0 || config.frequency_penalty > 2.0)
    ) {
        throw new RangeError("frequency_penalty", -2.0, 2.0);
    }
    if (
        config.presence_penalty &&
    (config.presence_penalty < -2.0 || config.presence_penalty > 2.0)
    ) {
        throw new RangeError("presence_penalty", -2.0, 2.0);
    }
    if (_hasValue(config.repetition_penalty) && config.repetition_penalty! <= 0) {
    throw new MinValueError("repetition_penalty", 0);
  }
  if (_hasValue(config.max_tokens) && config.max_tokens! <= 0) {
    throw new MinValueError("max_tokens", 0);
  }
  if ((_hasValue(config.top_p) && config.top_p! <= 0) || config.top_p! > 1) {
    throw new RangeError("top_p", 0, 1);
  }
  if (_hasValue(config.temperature) && config.temperature! < 0) {
    throw new NonNegativeError("temperature");
  }
  if (
    _hasValue(config.frequency_penalty) &&
    !_hasValue(config.presence_penalty)
  ) {
    config.presence_penalty = 0.0;
    log.warn("Only frequency_penalty is set; we default presence_penaty to 0.");
  }
  if (
    _hasValue(config.presence_penalty) &&
    !_hasValue(config.frequency_penalty)
  ) {
    config.frequency_penalty = 0.0;
    log.warn(
      "Only presence_penalty is set; we default frequency_penalty to 0.",
    );
  }

  //CHECK logi_bias range
  if (_hasValue(config.logit_bias)) {
    for (const tokenID in config.logit_bias) {
      const bias = config.logit_bias[tokenID];
      if (bias > 100 || bias < -100) {
        throw new RangeError(
          "logit_bias",
          -100,
          100,
          "Got " + bias + " for tokenID " + tokenID,
        );
      }
      if (isNaN(parseInt(tokenID))) {
        throw new InvalidNumberStringError("logit_bias's keys", tokenID);
      }
    }
  }
  if (_hasValue(config.top_logprobs)) {
    // If top_logprobs is non-null, logprobs must be true
    if (!config.logprobs) {
      throw new DependencyError("top_logprobs", "logprobs", true);
    }
    // top_logprobs should be in range [0,5]
    if (config.top_logprobs! < 0 || config.top_logprobs! > 5) {
      throw new RangeError("top_logprobs", 0, 5, "Got " + config.top_logprobs);
    }
  }
  if (config.logprobs){
    if(!_hasValue(config.top_logprobs)){
        config.top_logprobs = 5;
    }
  }
}

export enum ModelType {
  "LLM",
  "embedding",
  "VLM", // vision-language model
}

/**
 * Information for a model.
 * @param model: the huggingface link to download the model weights, accepting four formats:
 *    - https://huggingface.co/{USERNAME}/{MODEL}, which we automatically use the main branch
 *    - https://huggingface.co/{USERNAME}/{MODEL}/, which we automatically use the main branch
 *    - https://huggingface.co/{USERNAME}/{MODEL}/resolve/{BRANCH}
 *    - https://huggingface.co/{USERNAME}/{MODEL}/resolve/{BRANCH}/
 * @param model_id: what we call the model.
 * @param model_lib: link to the model library (wasm file) the model uses.
 * @param overrides: partial ChatConfig to override mlc-chat-config.json; can be used to change KVCache settings.
 * @param vram_required_MB: amount of vram in MB required to run the model (can use
 *    `utils/vram_requirements` to calculate).
 * @param low_resource_required: whether the model can run on limited devices (e.g. Android phone).
 * @param buffer_size_required_bytes: required `maxStorageBufferBindingSize`, different for each device.
 * @param required_features: feature needed to run this model (e.g. shader-f16).
 * @param model_type: the intended usecase for the model, if unspecified, default to LLM.
 */

export interface ModelRecord {
 model: string;
  model_id: string;
  model_lib: string;
  overrides?: ChatOptions;
  vram_required_MB?: number;
  low_resource_required?: boolean;
  buffer_size_required_bytes?: number;
  required_features?: Array<string>;
  model_type?: ModelType;
}

/**
 * Extra configuration that can be
 * passed to the load.
 *
 * @param model_list: models to be used.
 * @param useIndexedDBCache: if true, will use IndexedDBCache to cache models and other artifacts.
 * If false or unspecified, will use the Cache API. For more information of the two, see:
 * https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria#what_technologies_store_data_in_the_browser
 *
 * @note Note that the Cache API is more well-tested in WebLLM as of now.
 */
export interface AppConfig {
  model_list: Array<ModelRecord>;
  useIndexedDBCache?: boolean;
}


export const modelVersion = "v0_2_48";
export const modelLibURLPrefix =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/";

export const functionCallingModelIds = [
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
];

 /**
 * Default models and model library mapping to be used if unspecified.
 *
 * @note This is the only source of truth of which prebuilt model libraries are compatible with the
 * current WebLLM npm version.
 */

export const prebuiltAppConfig : AppConfig = {
    useIndexedDBCache: false,
    model_list : [
         {
      model: "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f32_1-MLC",
      model_id: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
      model_lib:
        modelLibURLPrefix +
        modelVersion +
        "/Llama-3.2-1B-Instruct-q4f32_1-ctx4k_cs1k-webgpu.wasm",
      vram_required_MB: 1128.82,
      low_resource_required: true,
      overrides: {
        context_window_size: 4096,
      },
    },
    ]
}
 

