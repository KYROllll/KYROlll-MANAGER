/*
 * KYROlll SOUL — Audio Unit v2 component shell.
 *
 * Builds a real universal Mach-O audio unit bundle (AUv2) that CoreAudio can
 * scan, register and load. The audio path is a genuine in-place stereo effect
 * with a gain parameter; the full SOUL saturation DSP is not part of this
 * repository, so `soul_process` is the integration point for it.
 *
 * Selector numbers follow the classic AUv2 plug-in ABI (AudioComponent.h).
 */

#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#include <math.h>
#include <stdbool.h>
#include <string.h>

/* Use the real AUv2 selector constants from AUComponent.h. */

#define kSoulGainParam 0
#define kSoulNumParams 1
#define kSoulSubtype 'Ksou'
#define kSoulManufacturer 'KYRO'
#define kSoulVersion 0x00010300
#define kSoulMaxListeners 8

typedef struct SoulAU {
  /* Must stay first: the AUv2 host passes the interface pointer back as
     `self` to every selector, so `(SoulAU *)self` has to be valid. */
  AudioComponentPlugInInterface iface;
  AudioComponentInstance instance;
  bool initialized;
  double sampleRate;
  UInt32 maxFrames;
  AudioStreamBasicDescription inputFormat;
  AudioStreamBasicDescription outputFormat;
  float gain; /* linear */
  bool bypass;
  float *scratch[2];
  AURenderCallback inputCallback;
  void *inputRefCon;
  OSStatus lastRenderError;
  AudioUnitPropertyID listenerProperty[kSoulMaxListeners];
  AudioUnitPropertyListenerProc listeners[kSoulMaxListeners];
  void *listenerRefCon[kSoulMaxListeners];
} SoulAU;

/* ---------- DSP ---------- */

/* The real SOUL saturation stage plugs in here. Until it ships this is a
   transparent stereo gain stage, which keeps the bundle a working audio unit
   instead of a placeholder file. */
static void soul_process(SoulAU *au, float *left, float *right, UInt32 frames) {
  if (au->bypass) return;
  const float gain = au->gain;
  if (gain == 1.0f) return;
  for (UInt32 i = 0; i < frames; i += 1) {
    if (left) left[i] *= gain;
    if (right) right[i] *= gain;
  }
}

/* ---------- helpers ---------- */

static void soul_default_format(AudioStreamBasicDescription *format, double sampleRate) {
  memset(format, 0, sizeof(*format));
  format->mSampleRate = sampleRate;
  format->mFormatID = kAudioFormatLinearPCM;
  format->mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
  format->mBytesPerPacket = sizeof(Float32);
  format->mFramesPerPacket = 1;
  format->mBytesPerFrame = sizeof(Float32);
  format->mChannelsPerFrame = 2;
  format->mBitsPerChannel = 32;
}

static SoulAU *soul_new(AudioComponentInstance instance) {
  SoulAU *au = (SoulAU *)calloc(1, sizeof(SoulAU));
  if (!au) return NULL;
  au->instance = instance;
  au->sampleRate = 44100.0;
  au->maxFrames = 1024;
  au->gain = 1.0f;
  au->bypass = false;
  au->scratch[0] = (float *)calloc(au->maxFrames, sizeof(float));
  au->scratch[1] = (float *)calloc(au->maxFrames, sizeof(float));
  au->lastRenderError = noErr;
  soul_default_format(&au->inputFormat, au->sampleRate);
  soul_default_format(&au->outputFormat, au->sampleRate);
  return au;
}

/* ---------- lifecycle ---------- */

static OSStatus soul_initialize(void *self) {
  SoulAU *au = (SoulAU *)self;
  au->initialized = true;
  return noErr;
}

static OSStatus soul_uninitialize(void *self) {
  SoulAU *au = (SoulAU *)self;
  au->initialized = false;
  return noErr;
}

static OSStatus soul_reset(void *self, AudioUnitScope scope, AudioUnitElement element) {
  (void)self;
  (void)scope;
  (void)element;
  return noErr;
}

/* ---------- property plumbing ---------- */

static bool soul_property_size(SoulAU *au, AudioUnitPropertyID id, AudioUnitScope scope, UInt32 *size) {
  (void)au;
  switch (id) {
    case kAudioUnitProperty_StreamFormat:
      *size = sizeof(AudioStreamBasicDescription);
      return true;
    case kAudioUnitProperty_SampleRate:
      *size = sizeof(Float64);
      return true;
    case kAudioUnitProperty_Latency:
    case kAudioUnitProperty_TailTime:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(Float64);
      return true;
    case kAudioUnitProperty_ElementCount:
    case kAudioUnitProperty_MaximumFramesPerSlice:
    case kAudioUnitProperty_InPlaceProcessing:
      *size = sizeof(UInt32);
      return true;
    case kAudioUnitProperty_BypassEffect:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(UInt32);
      return true;
    case kAudioUnitProperty_SetRenderCallback:
      *size = sizeof(AURenderCallbackStruct);
      return true;
    case kAudioUnitProperty_MakeConnection:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(AudioUnitConnection);
      return true;
    case kAudioUnitProperty_ParameterList:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(AudioUnitParameterID) * kSoulNumParams;
      return true;
    case kAudioUnitProperty_ParameterInfo:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(AudioUnitParameterInfo);
      return true;
    case kAudioUnitProperty_SupportedNumChannels:
      *size = sizeof(AUChannelInfo);
      return true;
    case kAudioUnitProperty_LastRenderError:
      *size = sizeof(OSStatus);
      return true;
    case kAudioUnitProperty_PresentPreset:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(AUPreset);
      return true;
    case kAudioUnitProperty_ClassInfo:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(CFPropertyListRef);
      return true;
    case kAudioUnitProperty_FactoryPresets:
      if (scope != kAudioUnitScope_Global) return false;
      *size = sizeof(CFArrayRef);
      return true;
    default:
      return false;
  }
}

static OSStatus soul_get_property_info(
    void *self,
    AudioUnitPropertyID id,
    AudioUnitScope scope,
    AudioUnitElement element,
    UInt32 *outSize,
    Boolean *outWritable) {
  SoulAU *au = (SoulAU *)self;
  UInt32 size = 0;
  if (!outSize) return kAudioUnitErr_InvalidParameter;
  if (element != 0) return kAudioUnitErr_InvalidElement;
  if (!soul_property_size(au, id, scope, &size)) return kAudioUnitErr_InvalidProperty;
  *outSize = size;
  if (outWritable) {
    *outWritable = id == kAudioUnitProperty_StreamFormat || id == kAudioUnitProperty_SampleRate ||
                   id == kAudioUnitProperty_MaximumFramesPerSlice || id == kAudioUnitProperty_InPlaceProcessing ||
                   id == kAudioUnitProperty_BypassEffect || id == kAudioUnitProperty_SetRenderCallback;
  }
  return noErr;
}

static void soul_parameter_info(AudioUnitParameterInfo *info) {
  memset(info, 0, sizeof(*info));
  strncpy(info->name, "Drive", sizeof(info->name) - 1);
  info->unit = kAudioUnitParameterUnit_Decibels;
  info->minValue = -60.0f;
  info->maxValue = 24.0f;
  info->defaultValue = 0.0f;
  info->flags = kAudioUnitParameterFlag_IsWritable | kAudioUnitParameterFlag_IsReadable | kAudioUnitParameterFlag_HasCFNameString;
  info->cfNameString = CFSTR("Drive");
}

static OSStatus soul_get_property(
    void *self,
    AudioUnitPropertyID id,
    AudioUnitScope scope,
    AudioUnitElement element,
    void *outData,
    UInt32 *ioSize) {
  SoulAU *au = (SoulAU *)self;
  if (!ioSize || !outData) return kAudioUnitErr_InvalidParameter;
  if (element != 0) return kAudioUnitErr_InvalidElement;

  switch (id) {
    case kAudioUnitProperty_StreamFormat: {
      if (*ioSize < sizeof(AudioStreamBasicDescription)) return kAudioUnitErr_InvalidPropertyValue;
      const AudioStreamBasicDescription *format =
          scope == kAudioUnitScope_Input ? &au->inputFormat : &au->outputFormat;
      memcpy(outData, format, sizeof(*format));
      *ioSize = sizeof(*format);
      return noErr;
    }
    case kAudioUnitProperty_SampleRate: {
      if (*ioSize < sizeof(Float64)) return kAudioUnitErr_InvalidPropertyValue;
      *(Float64 *)outData = au->sampleRate;
      *ioSize = sizeof(Float64);
      return noErr;
    }
    case kAudioUnitProperty_ElementCount: {
      if (*ioSize < sizeof(UInt32)) return kAudioUnitErr_InvalidPropertyValue;
      *(UInt32 *)outData = 1;
      *ioSize = sizeof(UInt32);
      return noErr;
    }
    case kAudioUnitProperty_MaximumFramesPerSlice: {
      if (*ioSize < sizeof(UInt32)) return kAudioUnitErr_InvalidPropertyValue;
      *(UInt32 *)outData = au->maxFrames;
      *ioSize = sizeof(UInt32);
      return noErr;
    }
    case kAudioUnitProperty_Latency:
    case kAudioUnitProperty_TailTime: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(Float64)) return kAudioUnitErr_InvalidPropertyValue;
      *(Float64 *)outData = 0.0;
      *ioSize = sizeof(Float64);
      return noErr;
    }
    case kAudioUnitProperty_InPlaceProcessing: {
      if (*ioSize < sizeof(UInt32)) return kAudioUnitErr_InvalidPropertyValue;
      *(UInt32 *)outData = 1;
      *ioSize = sizeof(UInt32);
      return noErr;
    }
    case kAudioUnitProperty_BypassEffect: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(UInt32)) return kAudioUnitErr_InvalidPropertyValue;
      *(UInt32 *)outData = au->bypass ? 1 : 0;
      *ioSize = sizeof(UInt32);
      return noErr;
    }
    case kAudioUnitProperty_MakeConnection: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(AudioUnitConnection)) return kAudioUnitErr_InvalidPropertyValue;
      /* Accept but ignore; we are in-place. */
      *ioSize = sizeof(AudioUnitConnection);
      return noErr;
    }
    case kAudioUnitProperty_ParameterList: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(AudioUnitParameterID)) return kAudioUnitErr_InvalidPropertyValue;
      ((AudioUnitParameterID *)outData)[0] = kSoulGainParam;
      *ioSize = sizeof(AudioUnitParameterID);
      return noErr;
    }
    case kAudioUnitProperty_ParameterInfo: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(AudioUnitParameterInfo)) return kAudioUnitErr_InvalidPropertyValue;
      soul_parameter_info((AudioUnitParameterInfo *)outData);
      *ioSize = sizeof(AudioUnitParameterInfo);
      return noErr;
    }
    case kAudioUnitProperty_SupportedNumChannels: {
      if (*ioSize < sizeof(AUChannelInfo)) return kAudioUnitErr_InvalidPropertyValue;
      AUChannelInfo *channels = (AUChannelInfo *)outData;
      channels[0].inChannels = 2;
      channels[0].outChannels = 2;
      *ioSize = sizeof(AUChannelInfo);
      return noErr;
    }
    case kAudioUnitProperty_LastRenderError: {
      if (*ioSize < sizeof(OSStatus)) return kAudioUnitErr_InvalidPropertyValue;
      *(OSStatus *)outData = au->lastRenderError;
      *ioSize = sizeof(OSStatus);
      return noErr;
    }
    case kAudioUnitProperty_PresentPreset: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(AUPreset)) return kAudioUnitErr_InvalidPropertyValue;
      AUPreset *preset = (AUPreset *)outData;
      preset->presetNumber = -1;
      preset->presetName = CFSTR("Untitled");
      CFRetain(preset->presetName);
      *ioSize = sizeof(AUPreset);
      return noErr;
    }
    case kAudioUnitProperty_ClassInfo: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(CFPropertyListRef)) return kAudioUnitErr_InvalidPropertyValue;
      CFMutableDictionaryRef dict = CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
      SInt32 version = kSoulVersion >> 16;
      CFNumberRef versionNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &version);
      CFDictionarySetValue(dict, CFSTR("version"), versionNum);
      CFRelease(versionNum);
      SInt32 typeVal = (SInt32)kAudioUnitType_Effect;
      CFNumberRef typeNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &typeVal);
      CFDictionarySetValue(dict, CFSTR("type"), typeNum);
      CFRelease(typeNum);
      SInt32 subtypeVal = (SInt32)kSoulSubtype;
      CFNumberRef subtypeNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &subtypeVal);
      CFDictionarySetValue(dict, CFSTR("subtype"), subtypeNum);
      CFRelease(subtypeNum);
      SInt32 mfrVal = (SInt32)kSoulManufacturer;
      CFNumberRef mfrNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &mfrVal);
      CFDictionarySetValue(dict, CFSTR("manufacturer"), mfrNum);
      CFRelease(mfrNum);
      CFDictionarySetValue(dict, CFSTR("name"), CFSTR(""));
      unsigned char blob[4] = { 'K','Y','R','O' };
      CFDataRef data = CFDataCreate(kCFAllocatorDefault, blob, 4);
      CFDictionarySetValue(dict, CFSTR("data"), data);
      CFRelease(data);
      *(CFPropertyListRef *)outData = dict;
      *ioSize = sizeof(CFPropertyListRef);
      return noErr;
    }
    case kAudioUnitProperty_FactoryPresets: {
      if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidProperty;
      if (*ioSize < sizeof(CFArrayRef)) return kAudioUnitErr_InvalidPropertyValue;
      *(CFArrayRef *)outData = CFArrayCreate(kCFAllocatorDefault, NULL, 0, NULL);
      *ioSize = sizeof(CFArrayRef);
      return noErr;
    }
    default:
      return kAudioUnitErr_InvalidProperty;
  }
}

static void soul_notify_listeners(SoulAU *au, AudioUnitPropertyID id) {
  for (int i = 0; i < kSoulMaxListeners; i += 1) {
    if (au->listeners[i] && au->listenerProperty[i] == id) {
      au->listeners[i](au->listenerRefCon[i], au->instance, id, kAudioUnitScope_Global, 0);
    }
  }
}

static OSStatus soul_set_property(
    void *self,
    AudioUnitPropertyID id,
    AudioUnitScope scope,
    AudioUnitElement element,
    const void *inData,
    UInt32 inSize) {
  SoulAU *au = (SoulAU *)self;
  if (element != 0 || !inData) return kAudioUnitErr_InvalidParameter;

  switch (id) {
    case kAudioUnitProperty_StreamFormat: {
      if (inSize < sizeof(AudioStreamBasicDescription)) return kAudioUnitErr_InvalidPropertyValue;
      const AudioStreamBasicDescription *format = (const AudioStreamBasicDescription *)inData;
      if (format->mFormatID != kAudioFormatLinearPCM) return kAudioUnitErr_FormatNotSupported;
      if (format->mChannelsPerFrame < 1 || format->mChannelsPerFrame > 2) return kAudioUnitErr_FormatNotSupported;
      if (scope == kAudioUnitScope_Input) {
        if (au->outputFormat.mChannelsPerFrame > 0 && au->outputFormat.mChannelsPerFrame != format->mChannelsPerFrame) return kAudioUnitErr_FormatNotSupported;
        au->inputFormat = *format;
      } else {
        if (au->inputFormat.mChannelsPerFrame > 0 && au->inputFormat.mChannelsPerFrame != format->mChannelsPerFrame) return kAudioUnitErr_FormatNotSupported;
        au->outputFormat = *format;
      }
      return noErr;
    }
    case kAudioUnitProperty_SampleRate: {
      if (inSize < sizeof(Float64)) return kAudioUnitErr_InvalidPropertyValue;
      au->sampleRate = *(const Float64 *)inData;
      au->inputFormat.mSampleRate = au->sampleRate;
      au->outputFormat.mSampleRate = au->sampleRate;
      return noErr;
    }
    case kAudioUnitProperty_MaximumFramesPerSlice: {
      if (inSize < sizeof(UInt32)) return kAudioUnitErr_InvalidPropertyValue;
      au->maxFrames = *(const UInt32 *)inData;
      soul_notify_listeners(au, kAudioUnitProperty_MaximumFramesPerSlice);
      return noErr;
    }
    case kAudioUnitProperty_InPlaceProcessing:
      return noErr;
    case kAudioUnitProperty_BypassEffect: {
      if (inSize < sizeof(UInt32)) return kAudioUnitErr_InvalidPropertyValue;
      au->bypass = *(const UInt32 *)inData != 0;
      return noErr;
    }
    case kAudioUnitProperty_SetRenderCallback: {
      if (inSize < sizeof(AURenderCallbackStruct)) return kAudioUnitErr_InvalidPropertyValue;
      const AURenderCallbackStruct *callback = (const AURenderCallbackStruct *)inData;
      au->inputCallback = callback->inputProc;
      au->inputRefCon = callback->inputProcRefCon;
      return noErr;
    }
    case kAudioUnitProperty_PresentPreset: {
      if (inSize < sizeof(AUPreset)) return kAudioUnitErr_InvalidPropertyValue;
      return noErr;
    }
    case kAudioUnitProperty_MakeConnection: {
      if (inSize < sizeof(AudioUnitConnection)) return kAudioUnitErr_InvalidPropertyValue;
      return noErr;
    }
    case kAudioUnitProperty_ClassInfo: {
      if (inSize < sizeof(CFPropertyListRef)) return kAudioUnitErr_InvalidPropertyValue;
      return noErr;
    }
    default:
      return kAudioUnitErr_InvalidProperty;
  }
}

/* ---------- parameters ---------- */

static OSStatus soul_get_parameter(
    void *self,
    AudioUnitParameterID id,
    AudioUnitScope scope,
    AudioUnitElement element,
    AudioUnitParameterValue *outValue) {
  SoulAU *au = (SoulAU *)self;
  if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidParameter;
  (void)element;
  if (id != kSoulGainParam || !outValue) return kAudioUnitErr_InvalidParameter;
  *outValue = 20.0f * log10f(au->gain > 0.0f ? au->gain : 0.000001f);
  return noErr;
}

static OSStatus soul_set_parameter(
    void *self,
    AudioUnitParameterID id,
    AudioUnitScope scope,
    AudioUnitElement element,
    AudioUnitParameterValue value,
    UInt32 offsetInFrames) {
  SoulAU *au = (SoulAU *)self;
  if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidParameter;
  (void)element;
  (void)offsetInFrames;
  if (id != kSoulGainParam) return kAudioUnitErr_InvalidParameter;
  au->gain = powf(10.0f, value / 20.0f);
  return noErr;
}

static OSStatus soul_schedule_parameters(void *self, const AudioUnitParameterEvent *events, UInt32 count) {
  SoulAU *au = (SoulAU *)self;
  for (UInt32 i = 0; i < count; i += 1) {
    if (events[i].parameter == kSoulGainParam && events[i].eventType == kParameterEvent_Immediate) {
      au->gain = powf(10.0f, events[i].eventValues.immediate.value / 20.0f);
    }
  }
  return noErr;
}

/* ---------- render ---------- */

static OSStatus soul_render(
    void *self,
    AudioUnitRenderActionFlags *ioActionFlags,
    const AudioTimeStamp *inTimeStamp,
    UInt32 inBusNumber,
    UInt32 inNumberFrames,
    AudioBufferList *ioData) {
  SoulAU *au = (SoulAU *)self;
  (void)inBusNumber;
  if (!ioData) return kAudioUnitErr_InvalidParameter;
  if (inNumberFrames > au->maxFrames) {
    au->lastRenderError = kAudioUnitErr_TooManyFramesToProcess;
    return au->lastRenderError;
  }

  /* Ensure buffers exist for hosts that hand us a null data pointer. */
  if (ioData->mNumberBuffers >= 1 && !ioData->mBuffers[0].mData) {
    ioData->mBuffers[0].mData = au->scratch[0];
    ioData->mBuffers[0].mDataByteSize = inNumberFrames * sizeof(float);
  }
  if (ioData->mNumberBuffers >= 2 && !ioData->mBuffers[1].mData) {
    ioData->mBuffers[1].mData = au->scratch[1];
    ioData->mBuffers[1].mDataByteSize = inNumberFrames * sizeof(float);
  }

  /* Pull input when the host supplied a callback instead of in-place data. */
  if (au->inputCallback) {
    OSStatus status = au->inputCallback(
        au->inputRefCon, ioActionFlags, inTimeStamp, 0, inNumberFrames, ioData);
    if (status != noErr) {
      au->lastRenderError = status;
      return status;
    }
  }

  if (ioData->mNumberBuffers >= 1) {
    float *left = (float *)ioData->mBuffers[0].mData;
    float *right = ioData->mNumberBuffers >= 2 ? (float *)ioData->mBuffers[1].mData : NULL;
    if (left) soul_process(au, left, right, inNumberFrames);
  }
  return noErr;
}

/* ---------- listeners ---------- */

static OSStatus soul_add_property_listener(
    void *self,
    AudioUnitPropertyID id,
    AudioUnitPropertyListenerProc proc,
    void *refCon) {
  SoulAU *au = (SoulAU *)self;
  for (int i = 0; i < kSoulMaxListeners; i += 1) {
    if (!au->listeners[i]) {
      au->listenerProperty[i] = id;
      au->listeners[i] = proc;
      au->listenerRefCon[i] = refCon;
      return noErr;
    }
  }
  return noErr;
}

static OSStatus soul_remove_property_listener(void *self, AudioUnitPropertyID id, AudioUnitPropertyListenerProc proc) {
  SoulAU *au = (SoulAU *)self;
  for (int i = 0; i < kSoulMaxListeners; i += 1) {
    if (au->listeners[i] == proc && (id == 0 || au->listenerProperty[i] == id)) {
      au->listenerProperty[i] = 0;
      au->listeners[i] = NULL;
      au->listenerRefCon[i] = NULL;
      return noErr;
    }
  }
  return noErr;
}

static OSStatus soul_remove_property_listener_with_user_data(void *self, AudioUnitPropertyID id, AudioUnitPropertyListenerProc proc, void *userData) {
  SoulAU *au = (SoulAU *)self;
  for (int i = 0; i < kSoulMaxListeners; i += 1) {
    if (au->listeners[i] == proc && au->listenerRefCon[i] == userData && (id == 0 || au->listenerProperty[i] == id)) {
      au->listenerProperty[i] = 0;
      au->listeners[i] = NULL;
      au->listenerRefCon[i] = NULL;
      return noErr;
    }
  }
  return noErr;
}

static OSStatus soul_render_notify_noop(void *self, AURenderCallback callback, void *refCon) {
  (void)self;
  (void)callback;
  (void)refCon;
  return noErr;
}

/* ---------- dispatch ---------- */

static AudioComponentMethod soul_lookup(SInt16 selector) {
  switch (selector) {
    case kAudioUnitInitializeSelect:
      return (AudioComponentMethod)soul_initialize;
    case kAudioUnitUninitializeSelect:
      return (AudioComponentMethod)soul_uninitialize;
    case kAudioUnitGetPropertyInfoSelect:
      return (AudioComponentMethod)soul_get_property_info;
    case kAudioUnitGetPropertySelect:
      return (AudioComponentMethod)soul_get_property;
    case kAudioUnitSetPropertySelect:
      return (AudioComponentMethod)soul_set_property;
    case kAudioUnitResetSelect:
      return (AudioComponentMethod)soul_reset;
    case kAudioUnitAddPropertyListenerSelect:
      return (AudioComponentMethod)soul_add_property_listener;
    case kAudioUnitRemovePropertyListenerSelect:
    case kAudioUnitRemovePropertyListenerWithUserDataSelect:
      return (AudioComponentMethod)soul_remove_property_listener_with_user_data;
    case kAudioUnitRenderSelect:
      return (AudioComponentMethod)soul_render;
    case kAudioUnitAddRenderNotifySelect:
    case kAudioUnitRemoveRenderNotifySelect:
      return (AudioComponentMethod)soul_render_notify_noop;
    case kAudioUnitGetParameterSelect:
      return (AudioComponentMethod)soul_get_parameter;
    case kAudioUnitSetParameterSelect:
      return (AudioComponentMethod)soul_set_parameter;
    case kAudioUnitScheduleParametersSelect:
      return (AudioComponentMethod)soul_schedule_parameters;
    default:
      return NULL;
  }
}

static OSStatus soul_open(void *self, AudioComponentInstance instance) {
  SoulAU *au = (SoulAU *)self;
  au->instance = instance;
  return noErr;
}

static OSStatus soul_close(void *self) {
  SoulAU *au = (SoulAU *)self;
  free(au->scratch[0]);
  free(au->scratch[1]);
  au->scratch[0] = NULL;
  au->scratch[1] = NULL;
  au->initialized = false;
  return noErr;
}

__attribute__((visibility("default"))) AudioComponentPlugInInterface *KYROlllSoulFactory(
    const AudioComponentDescription *inDesc) {
  if (inDesc && (inDesc->componentType != kAudioUnitType_Effect || inDesc->componentSubType != kSoulSubtype)) {
    return NULL;
  }
  SoulAU *au = soul_new(NULL);
  if (!au) return NULL;
  au->iface.Open = soul_open;
  au->iface.Close = soul_close;
  au->iface.Lookup = soul_lookup;
  au->iface.reserved = NULL;
  return &au->iface;
}

__attribute__((visibility("default"))) void *KYROlllSoulAUVersion(void) {
  return (void *)(uintptr_t)kSoulVersion;
}
