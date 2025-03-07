import {
    AutoTokenizer,
    AutoProcessor,
    WhisperForConditionalGeneration,
    TextStreamer,
    Tensor,
    PreTrainedTokenizer,
    Processor,
    PreTrainedModel,
} from '@huggingface/transformers';

const AUDIO_SAMPLING_RATE = 16_000; // 16,000 Hz (16 kHz); number of audio samples captured per second
const AUDIO_PROCESSING_TIME = 2000; // 2 seconds
const OVERLAP_TIME = 200; // 200ms overlap between iterations of processing
const MODEL_NAME = 'onnx-community/whisper-base'; // best model for the web I've found so far
const MODEL_DEVICE = 'webgpu';
const MODEL_FORMAT = 'fp32'; // single-precision floating-point 32-bit format
const TARGET_LANGUAGE = 'en'; // english
const MAX_OUTPUT_TOKENS = 64;
const SHOULD_PROCESS_LOCAL = false; // if true use local model; if false use remote Cloudflare worker

// buffer audio chunks as they come in to the web worker
let audioChunkBuffer = new Float32Array(0);
let isWorkerRunning = true;
let useRemoteModels = true; // use remote models by default (only local if initialized successfully)

// These are the HuggingFace model objects used to do the heavy lifting for transcribing audio
let processor: Processor | null = null;
let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;

// inbound event handler from the main thread to this worker process
addEventListener('message', (event) => {
    const eventData: InboundEventData = event.data || {};

    if (eventData.type === InboundEventDataType.INIT_MODEL_LOCAL) {
        initializeModelLocally();
    } else if (eventData.type === InboundEventDataType.INIT_MODEL_REMOTE) {
        initializeModelRemote();
    } else if (eventData.type === InboundEventDataType.AUDIO) {
        audioChunkBuffer = concatenateFloat32Arrays(audioChunkBuffer, eventData.audioChunk);
    } else if (eventData.type === InboundEventDataType.STOP) {
        isWorkerRunning = false;
    } else if (eventData.type === InboundEventDataType.LOG) {
        console.log(eventData.text);
    } else {
        console.error(`Invalid inbound worker message=${JSON.stringify({ eventData })}`);
    }
});

/**
 * Post data outbound back to the main thread from this worker process
 */
function postOutboundEvent(eventData: OutboundEventData) {
    postMessage(eventData);
}

/**
 * Helper function to concatenate Float32Arrays
 */
function concatenateFloat32Arrays(buffer1: Float32Array, buffer2: Float32Array = new Float32Array(0)): Float32Array {
    const tmp = new Float32Array(buffer1.length + buffer2.length);
    tmp.set(buffer1, 0);
    tmp.set(buffer2, buffer1.length);
    return tmp;
}

async function initializeModelRemote() {
    // local models ready now, so stop using remote models
    useRemoteModels = true;

    // now that model is initialized, start processing audio chunks
    runAudioProcessorDaemon();
}

/**
 * Initialize the HuggingFace model objects and (if successful) start the audio processing daemon
 */
async function initializeModelLocally() {
    // TODO: get this from cache and save in cache...

    try {
        const startTime = Date.now();
        const modelOpts: any = {
            dtype: {
                encoder_model: MODEL_FORMAT,
                decoder_model_merged: MODEL_FORMAT,
            },
            device: MODEL_DEVICE,
        };

        const resp = await Promise.all([
            AutoProcessor.from_pretrained(MODEL_NAME, {}),
            AutoTokenizer.from_pretrained(MODEL_NAME, {}),
            WhisperForConditionalGeneration.from_pretrained(MODEL_NAME, modelOpts),
        ]);
        processor = resp[0];
        tokenizer = resp[1];
        model = resp[2];
        const endTime = Date.now();
        const duration = endTime - startTime;
        postOutboundEvent({ type: OutboundEventDataType.READY, text: `Finished in ${duration}ms` });

        // local models ready now, so stop using remote models
        useRemoteModels = false;

        // now that model is initialized, start processing audio chunks
        runAudioProcessorDaemon();
    } catch (ex) {
        console.error(ex);
        postOutboundEvent({ type: OutboundEventDataType.ERROR, text: 'Error occurred while initializing model', error: ex as Error });
    }
}

/**
 * Audio will continue to get added to the audioChunkBuffer as it comes in from the main thread.
 * This function is in charge of simply monitoring the audioChunkBuffer for when there is enough
 * audio to process and then sending that chunk off to the processAudioChunk function.
 */
async function runAudioProcessorDaemon() {
    const audioProcessingLength = AUDIO_SAMPLING_RATE * (AUDIO_PROCESSING_TIME / 1000);
    const audioOverlapLength = AUDIO_SAMPLING_RATE * (OVERLAP_TIME / 1000);

    while (isWorkerRunning) {
        if (audioChunkBuffer.length >= audioProcessingLength) {
            // get the audio chunk to process
            const audioToProcess = audioChunkBuffer.slice(0, audioProcessingLength);

            // modify the buffer to remove the audio we're about to process minus some overlap
            // we do this to try and avoid cutting off a word in the middle
            audioChunkBuffer = audioChunkBuffer.slice(audioProcessingLength - audioOverlapLength);

            // process the audio chunk
            await processAudioChunk(audioToProcess);
        }

        // if not enough audio to process, wait a bit before checking again
        if (audioChunkBuffer.length < audioProcessingLength) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}

/**
 * This is the primary function for using the models to transcribe one audio chunk
 */
async function processAudioChunk(audioChunk?: Float32Array) {
    if (!audioChunk?.length) {
        return;
    }

    if (SHOULD_PROCESS_LOCAL) {
        processAudioChunkLocally(audioChunk);
    } else {
        processAudioChunkRemotely(audioChunk);
    }
}

async function processAudioChunkLocally(audioChunk: Float32Array) {
    if (!tokenizer || !processor || !model) {
        console.error('processAudioChunk called before model initialized');
        return;
    }

    // audio proprocessing which includes:
    //      - feature extraction: converting raw audio into log-Mel spectrogram
    //      - normalization: scaling the audio features to a specific range
    const inputs = await processor(audioChunk);

    const modelGenerationConfig: any = {
        ...inputs,
        max_new_tokens: MAX_OUTPUT_TOKENS, // can be small because we only process 2 seconds of audio at a time
        language: TARGET_LANGUAGE,
        streamer: new TextStreamer(tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
        }),
    };

    // model generates output tokens based on the input tokens (NOTE: tokens !== words)
    const outputs = (await model.generate(modelGenerationConfig)) as Tensor;

    // finally we need the tokenizer to conver the tokens to actual english words
    const outputText = tokenizer.batch_decode(outputs, { skip_special_tokens: true })[0];

    // return the transcribed text to the main thread
    postOutboundEvent({ type: OutboundEventDataType.TRANSCRIPTION, text: outputText });
}

async function processAudioChunkRemotely(audioChunk: Float32Array) {
    // Convert Float32Array to Int16Array (PCM 16-bit)
    const int16Audio = float32ToInt16(audioChunk);

    // encode as WAV
    const wavBuffer = encodeWAV(int16Audio, AUDIO_SAMPLING_RATE);

    // Convert to Uint8Array for sending
    const wavUint8Array = new Uint8Array(wavBuffer);

    try {
        const response = await fetch('https://whisper-worker.gethuman.workers.dev', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Add any other headers your Cloudflare Worker might require (e.g., authentication)
            },
            body: JSON.stringify({
                sampleRate: AUDIO_SAMPLING_RATE,
                audioChunk: Array.from(wavUint8Array),
            }),
        });

        if (!response.ok) {
            // Handle non-2xx responses (e.g., 400, 500 errors)
            const errorText = await response.text(); // Get error message from response body
            console.error(`Error sending audio chunk: ${response.status} ${response.statusText}`, errorText);
            // Consider throwing an error or showing an error message to the user
            throw new Error(`Server responded with ${response.status}: ${errorText}`);
        }

        const responseData = await response.json(); // Assuming the worker returns JSON
        console.log('Server response:', responseData); // Process the server's response

        // return the transcribed text to the main thread
        postOutboundEvent({ type: OutboundEventDataType.TRANSCRIPTION, text: responseData.transcription });
    } catch (error) {
        console.error('Error sending audio chunk:', error);
    }
}

/**
 * Converts a Float32Array (assumed to be in the range -1.0 to +1.0) to an Int16Array.
 * This function performs clamping to avoid overflow.
 */
function float32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const sample = float32Array[i] || 0;
        // Clamp the sample to the range -1.0 to +1.0, then scale and convert to int16.
        const scaledSample = Math.max(-1, Math.min(1, sample)) * 32767;
        int16Array[i] = Math.round(scaledSample); // Round to nearest integer
    }
    return int16Array;
}

function encodeWAV(samples: Int16Array, sampleRate: number): ArrayBuffer {
    const numChannels = 1; // Mono
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = samples.length * 2; // Each sample is 2 bytes (16-bit)

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true); // File size
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
    view.setUint16(22, numChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, byteRate, true); // ByteRate
    view.setUint16(32, blockAlign, true); // BlockAlign
    view.setUint16(34, bitsPerSample, true); // BitsPerSample

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true); // Data size

    // Write the PCM samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        view.setInt16(offset, samples[i], true);
    }

    return buffer;
}

// Helper function to write ASCII strings to a DataView
function writeString(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
    }
}

// **** models below ****

interface InboundEventData {
    type: InboundEventDataType;
    audioChunk?: Float32Array;
    text?: string;
}

enum InboundEventDataType {
    AUDIO = 'audio',
    INIT_MODEL_LOCAL = 'init_model_local',
    INIT_MODEL_REMOTE = 'init_model_remote',
    DESTROY = 'destroy',
    STOP = 'stop',
    START = 'start',
    LOG = 'log',
}

interface OutboundEventData {
    type: OutboundEventDataType;
    text?: string;
    error?: Error;
}

enum OutboundEventDataType {
    TRANSCRIPTION = 'transcription',
    READY = 'ready',
    ERROR = 'error',
}
