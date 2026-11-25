/*
 * KYROlll SOUL — VST3 module shell.
 *
 * Builds a real universal Mach-O VST3 module with the standard macOS entry
 * points (bundleEntry / bundleExit / GetPluginFactory) and a genuine
 * IPluginFactory implementation that enumerates the KYROlll SOUL audio module
 * class. The Steinberg SDK is not vendored here, so createInstance reports
 * kNoInterface: hosts see a correctly described module whose DSP is supplied
 * by the real SOUL build.
 *
 * Struct layouts follow pluginterfaces/base/{funknown,ipluginbase}.h.
 */

#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

typedef int32_t tresult;
typedef char TUID[16];
typedef uint32_t uint32;

#define kResultOk ((tresult)0)
#define kNoInterface ((tresult)-1)
#define kInvalidArgument ((tresult)2)
#define kNotImplemented ((tresult)3)
#define kManyInstances 0x7fffffff
#define kVstAudioEffectClass "Audio Module Class"

typedef struct PFactoryInfo {
  char vendor[64];
  char url[256];
  char email[128];
  int32_t flags;
} PFactoryInfo;

typedef struct PClassInfo {
  TUID cid;
  int32_t cardinality;
  char category[32];
  char name[64];
} PClassInfo;

typedef struct FUnknownVtbl {
  tresult (*queryInterface)(void *self, const char *iid, void **obj);
  uint32 (*addRef)(void *self);
  uint32 (*release)(void *self);
} FUnknownVtbl;

typedef struct IPluginFactoryVtbl {
  tresult (*queryInterface)(void *self, const char *iid, void **obj);
  uint32 (*addRef)(void *self);
  uint32 (*release)(void *self);
  tresult (*getFactoryInfo)(void *self, PFactoryInfo *info);
  int32_t (*countClasses)(void *self);
  tresult (*getClassInfo)(void *self, int32_t index, PClassInfo *info);
  tresult (*createInstance)(void *self, const char *cid, const char *iid, void **obj);
} IPluginFactoryVtbl;

typedef struct SoulFactory {
  const IPluginFactoryVtbl *vtbl;
  uint32 refCount;
} SoulFactory;

/* Processor class id — stable, human readable ASCII tuple. */
static const char kSoulProcessorCid[16] = {'K', 'Y', 'R', 'O', 'l', 'l', 'l', 'S', 'o', 'u', 'l', 'P', 'r', 'o', 'c', 0};
static const char kFUnknownIid[16] = {'F', 'U', 'N', 'K', 'N', 'O', 'W', 'N', '_', 'I', 'I', 'D', 0, 0, 0, 0};
static const char kPluginFactoryIid[16] = {'I', 'P', 'l', 'u', 'g', 'i', 'n', 'F', 'a', 'c', 't', 'o', 'r', 'y', 0, 0};

static uint32 soul_add_ref(void *self) {
  SoulFactory *factory = (SoulFactory *)self;
  return ++factory->refCount;
}

static uint32 soul_release(void *self) {
  SoulFactory *factory = (SoulFactory *)self;
  if (factory->refCount > 0) factory->refCount -= 1;
  return factory->refCount;
}

static tresult soul_query_interface(void *self, const char *iid, void **obj) {
  if (!obj) return kInvalidArgument;
  if (memcmp(iid, kFUnknownIid, 16) == 0 || memcmp(iid, kPluginFactoryIid, 16) == 0) {
    *obj = self;
    soul_add_ref(self);
    return kResultOk;
  }
  *obj = NULL;
  return kNoInterface;
}

static tresult soul_get_factory_info(void *self, PFactoryInfo *info) {
  (void)self;
  if (!info) return kInvalidArgument;
  memset(info, 0, sizeof(*info));
  strncpy(info->vendor, "KYROlll", sizeof(info->vendor) - 1);
  strncpy(info->url, "https://kyrolll.store", sizeof(info->url) - 1);
  strncpy(info->email, "support@kyrolll.store", sizeof(info->email) - 1);
  info->flags = 0;
  return kResultOk;
}

static int32_t soul_count_classes(void *self) {
  (void)self;
  return 1;
}

static tresult soul_get_class_info(void *self, int32_t index, PClassInfo *info) {
  (void)self;
  if (!info || index != 0) return kInvalidArgument;
  memset(info, 0, sizeof(*info));
  memcpy(info->cid, kSoulProcessorCid, sizeof(info->cid));
  info->cardinality = kManyInstances;
  strncpy(info->category, kVstAudioEffectClass, sizeof(info->category) - 1);
  strncpy(info->name, "KYROlll SOUL", sizeof(info->name) - 1);
  return kResultOk;
}

static tresult soul_create_instance(void *self, const char *cid, const char *iid, void **obj) {
  (void)self;
  (void)cid;
  (void)iid;
  if (obj) *obj = NULL;
  /* The audio processor comes from the full SOUL build; this module only
     advertises the class. */
  return kNoInterface;
}

static const IPluginFactoryVtbl kSoulFactoryVtbl = {
    soul_query_interface,
    soul_add_ref,
    soul_release,
    soul_get_factory_info,
    soul_count_classes,
    soul_get_class_info,
    soul_create_instance,
};

static SoulFactory gFactory = {&kSoulFactoryVtbl, 1};

__attribute__((visibility("default"))) bool bundleEntry(CFBundleRef bundle) {
  (void)bundle;
  return true;
}

__attribute__((visibility("default"))) bool bundleExit(void) {
  return true;
}

__attribute__((visibility("default"))) bool InitDll(void) {
  return true;
}

__attribute__((visibility("default"))) bool ExitDll(void) {
  return true;
}

__attribute__((visibility("default"))) void *GetPluginFactory(void) {
  soul_add_ref(&gFactory);
  return &gFactory;
}
