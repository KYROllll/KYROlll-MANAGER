'use strict';

/**
 * Tiny PE32+ (x86-64) DLL writer.
 *
 * The KYROlll SOUL Windows payload is generated from this module so the
 * repository can ship a genuine PE image — a real DOS/PE header, a code
 * section with the VST3 entry points, and an export directory — without
 * requiring a Windows or MinGW toolchain on the build machine.
 *
 * The result is a loadable module shell: DllMain returns TRUE and the
 * standard VST3 exports (GetPluginFactory / InitDll / ExitDll) are present.
 * The full SOUL DSP is supplied by the shipping build, exactly like the
 * macOS module shell.
 */

const FILE_ALIGN = 0x200;
const SECTION_ALIGN = 0x1000;
const IMAGE_BASE = 0x180000000n;

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function writeSectionHeader(file, offset, name, virtualSize, virtualAddress, rawSize, rawPointer, characteristics) {
  file.write(name.padEnd(8, '\0'), offset, 'ascii');
  file.writeUInt32LE(virtualSize, offset + 8);
  file.writeUInt32LE(virtualAddress, offset + 12);
  file.writeUInt32LE(rawSize, offset + 16);
  file.writeUInt32LE(rawPointer, offset + 20);
  file.writeUInt32LE(0, offset + 24); // PointerToRelocations
  file.writeUInt32LE(0, offset + 28); // PointerToLinenumbers
  file.writeUInt16LE(0, offset + 32); // NumberOfRelocations
  file.writeUInt16LE(0, offset + 34); // NumberOfLinenumbers
  file.writeUInt32LE(characteristics, offset + 36);
}

function buildTextSection(exports) {
  // DllMain lives at RVA 0x1000. Each export gets its own 16-byte slot so the
  // export table points at stable, distinct addresses.
  const buffer = Buffer.alloc(0x200);
  const offsets = {};
  let cursor = 0;

  buffer.set([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3], cursor); // mov eax, 1; ret
  cursor += 0x10;

  for (const name of exports) {
    offsets[name] = 0x1000 + cursor;
    if (name === 'GetPluginFactory') {
      // Returning NULL is the documented "no factory" shell; hosts still see
      // a correctly formed module with the export present.
      buffer.set([0x33, 0xc0, 0xc3], cursor); // xor eax, eax; ret
    } else {
      buffer.set([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3], cursor); // mov eax, 1; ret
    }
    cursor += 0x10;
  }

  return { buffer: buffer.subarray(0, align(cursor, 0x10)), offsets };
}

function buildExportSection(dllName, exports, baseRva) {
  const count = exports.length;
  const headerSize = 40;
  const eatOffset = headerSize;
  const namesOffset = eatOffset + count * 4;
  const ordinalsOffset = namesOffset + count * 4;
  const stringsOffset = ordinalsOffset + count * 2;

  const strings = [];
  let cursor = stringsOffset;
  const moduleNameRva = baseRva + cursor;
  const moduleName = Buffer.from(`${dllName}\0`, 'utf8');
  strings.push(moduleName);
  cursor += moduleName.length;

  const nameRvas = [];
  for (const entry of exports) {
    nameRvas.push(baseRva + cursor);
    const name = Buffer.from(`${entry.name}\0`, 'utf8');
    strings.push(name);
    cursor += name.length;
  }

  const total = align(cursor, 4);
  const section = Buffer.alloc(total);

  section.writeUInt32LE(0, 0); // Characteristics
  section.writeUInt32LE(0, 4); // TimeDateStamp
  section.writeUInt16LE(0, 8); // MajorVersion
  section.writeUInt16LE(0, 10); // MinorVersion
  section.writeUInt32LE(moduleNameRva, 12);
  section.writeUInt32LE(1, 16); // Ordinal base
  section.writeUInt32LE(count, 20); // NumberOfFunctions
  section.writeUInt32LE(count, 24); // NumberOfNames
  section.writeUInt32LE(baseRva + eatOffset, 28);
  section.writeUInt32LE(baseRva + namesOffset, 32);
  section.writeUInt32LE(baseRva + ordinalsOffset, 36);

  exports.forEach((entry, index) => {
    section.writeUInt32LE(entry.rva, eatOffset + index * 4);
    section.writeUInt32LE(nameRvas[index], namesOffset + index * 4);
    section.writeUInt16LE(index, ordinalsOffset + index * 2);
  });

  let stringOffset = stringsOffset;
  for (const value of strings) {
    value.copy(section, stringOffset);
    stringOffset += value.length;
  }

  return section;
}

/**
 * Build a PE32+ DLL image.
 *
 * @param {object} options
 * @param {string} options.dllName  Exported module name (usually the .vst3 file).
 * @param {string[]} [options.exports] Export names.
 * @returns {Buffer}
 */
function buildDll({ dllName, exports = ['GetPluginFactory', 'InitDll', 'ExitDll'] }) {
  if (!dllName) throw new Error('dllName is required');
  const unique = [...new Set(exports)];
  const sorted = [...unique].sort((a, b) => a.localeCompare(b));

  const textBase = 0x1000;
  const dataBase = 0x2000;
  const text = buildTextSection(sorted);
  const exportEntries = sorted.map((name) => ({ name, rva: text.offsets[name] }));
  const edata = buildExportSection(dllName, exportEntries, dataBase);

  const textRawSize = align(text.buffer.length, FILE_ALIGN);
  const edataRawSize = align(edata.length, FILE_ALIGN);
  const headersSize = 0x200;
  const textRawPointer = headersSize;
  const edataRawPointer = textRawPointer + textRawSize;
  const sizeOfImage = align(dataBase + edata.length, SECTION_ALIGN);

  const file = Buffer.alloc(edataRawPointer + edataRawSize);

  // ---- DOS header -----------------------------------------------------
  file.write('MZ', 0, 'ascii');
  file.writeUInt16LE(0x90, 0x02); // e_cblp
  file.writeUInt16LE(0x03, 0x04); // e_cp
  file.writeUInt16LE(0x00, 0x06); // e_crlc
  file.writeUInt16LE(0x04, 0x08); // e_cparhdr
  file.writeUInt16LE(0x00, 0x0a); // e_minalloc
  file.writeUInt16LE(0xffff, 0x0c); // e_maxalloc
  file.writeUInt16LE(0x00, 0x0e); // e_ss
  file.writeUInt16LE(0xb8, 0x10); // e_sp
  file.writeUInt16LE(0x00, 0x12); // e_csum
  file.writeUInt16LE(0x00, 0x14); // e_ip
  file.writeUInt16LE(0x00, 0x16); // e_cs
  file.writeUInt16LE(0x40, 0x18); // e_lfarlc
  file.writeUInt16LE(0x00, 0x1a); // e_ovno
  file.writeUInt32LE(0x40, 0x3c); // e_lfanew

  // ---- PE signature + COFF header -------------------------------------
  file.write('PE\0\0', 0x40, 'binary');
  const coff = 0x44;
  file.writeUInt16LE(0x8664, coff); // IMAGE_FILE_MACHINE_AMD64
  file.writeUInt16LE(2, coff + 2); // NumberOfSections
  file.writeUInt32LE(0x65000000, coff + 4); // TimeDateStamp
  file.writeUInt32LE(0, coff + 8); // PointerToSymbolTable
  file.writeUInt32LE(0, coff + 12); // NumberOfSymbols
  file.writeUInt16LE(0xf0, coff + 16); // SizeOfOptionalHeader
  file.writeUInt16LE(0x2022, coff + 18); // DLL | EXECUTABLE | LARGE_ADDRESS_AWARE

  // ---- Optional header (PE32+) ----------------------------------------
  const opt = 0x58;
  file.writeUInt16LE(0x20b, opt + 0x00); // Magic
  file.writeUInt8(14, opt + 0x02); // MajorLinkerVersion
  file.writeUInt8(0, opt + 0x03); // MinorLinkerVersion
  file.writeUInt32LE(textRawSize, opt + 0x04); // SizeOfCode
  file.writeUInt32LE(edataRawSize, opt + 0x08); // SizeOfInitializedData
  file.writeUInt32LE(0, opt + 0x0c); // SizeOfUninitializedData
  file.writeUInt32LE(textBase, opt + 0x10); // AddressOfEntryPoint
  file.writeUInt32LE(textBase, opt + 0x14); // BaseOfCode
  file.writeBigUInt64LE(IMAGE_BASE, opt + 0x18); // ImageBase
  file.writeUInt32LE(SECTION_ALIGN, opt + 0x20);
  file.writeUInt32LE(FILE_ALIGN, opt + 0x24);
  file.writeUInt16LE(6, opt + 0x28); // MajorOperatingSystemVersion
  file.writeUInt16LE(0, opt + 0x2a); // MinorOperatingSystemVersion
  file.writeUInt16LE(0, opt + 0x2c); // MajorImageVersion
  file.writeUInt16LE(0, opt + 0x2e); // MinorImageVersion
  file.writeUInt16LE(6, opt + 0x30); // MajorSubsystemVersion
  file.writeUInt16LE(0, opt + 0x32); // MinorSubsystemVersion
  file.writeUInt32LE(0, opt + 0x34); // Win32VersionValue
  file.writeUInt32LE(sizeOfImage, opt + 0x38); // SizeOfImage
  file.writeUInt32LE(headersSize, opt + 0x3c); // SizeOfHeaders
  file.writeUInt32LE(0, opt + 0x40); // CheckSum
  file.writeUInt16LE(2, opt + 0x44); // Subsystem = GUI
  file.writeUInt16LE(0x0160, opt + 0x46); // NX_COMPAT | DYNAMIC_BASE | HIGH_ENTROPY_VA
  file.writeBigUInt64LE(0x100000n, opt + 0x48); // SizeOfStackReserve
  file.writeBigUInt64LE(0x1000n, opt + 0x50); // SizeOfStackCommit
  file.writeBigUInt64LE(0x100000n, opt + 0x58); // SizeOfHeapReserve
  file.writeBigUInt64LE(0x1000n, opt + 0x60); // SizeOfHeapCommit
  file.writeUInt32LE(0, opt + 0x68); // LoaderFlags
  file.writeUInt32LE(16, opt + 0x6c); // NumberOfRvaAndSizes

  // Data directory 0 = export table.
  file.writeUInt32LE(dataBase, opt + 0x70);
  file.writeUInt32LE(edata.length, opt + 0x74);

  // ---- Section headers -------------------------------------------------
  writeSectionHeader(
    file,
    0x148,
    '.text',
    text.buffer.length,
    textBase,
    textRawSize,
    textRawPointer,
    0x60000020 // CNT_CODE | MEM_EXECUTE | MEM_READ
  );
  writeSectionHeader(
    file,
    0x170,
    '.edata',
    edata.length,
    dataBase,
    edataRawSize,
    edataRawPointer,
    0x40000040 // CNT_INITIALIZED_DATA | MEM_READ
  );

  // ---- Section bodies --------------------------------------------------
  text.buffer.copy(file, textRawPointer);
  edata.copy(file, edataRawPointer);

  return file;
}

module.exports = { buildDll };
