"""Exercise the full queue style command, including the Lua return epilogue."""
import os
from pathlib import Path
from struct import pack, unpack
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_EDI, UC_X86_REG_ESI, UC_X86_REG_ESP

root = Path(__file__).resolve().parents[1]
hud = Path(os.environ.get('PACKAGED_NATIVE', root / 'payload/resources/native')) / 'hud'
machine = Uc(UC_ARCH_X86, UC_MODE_32)
for address, size in [(0x100000, 0x3000), (0x41b000, 0x1000), (0x1d92000, 0x1000), (0x1da8800 & ~0xfff, 0x1000)]:
    machine.mem_map(address, size)

layout, extension, mode = 0x1da8800, 0x1da8e00, 0x1d920f0
bridge = bytearray((hud / 'layout-x86.bin').read_bytes())
assert bridge[0x144:0x14b] == bytes.fromhex('ba9d8cda0189d8')
bridge[0x144:0x14b] = b'\xe9'+pack('<i', extension-(layout+0x144)-5)+b'\x90\x90'
machine.mem_write(layout, bytes(bridge))
machine.mem_write(extension, (hud / 'queue-icons-x86.bin').read_bytes())
context, pointer, state, args, name = (0x100100, 0x100200, 0x100300, 0x100500, 0x100900)
stack, done = 0x102000, 0x101000
machine.mem_write(context+0x7c, pack('<I', pointer))
machine.mem_write(pointer+0x1c, pack('<I', state))
machine.mem_write(name, b'rf_queue_color\0')
machine.mem_write(0x41b060, b'\xb8'+pack('<I', name)+b'\xc3')

for value in (1.0, 0.0):
    machine.mem_write(state+0x20, pack('<2I', args+48, args))
    machine.mem_write(args, pack('<5If6I', 4, 0, 4, 0, 3, value, 3, 0, 3, 0, 3, 0))
    machine.mem_write(stack, pack('<2I', done, context))
    machine.reg_write(UC_X86_REG_ESP, stack)
    for register in (UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_ESI, UC_X86_REG_EDI):
        machine.reg_write(register, 0x12345678)
    machine.emu_start(layout+0xdd, done, count=5000)
    assert machine.reg_read(UC_X86_REG_ESP) == stack+4
    for register in (UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_ESI, UC_X86_REG_EDI):
        assert machine.reg_read(register) == 0x12345678
    assert machine.reg_read(UC_X86_REG_EAX) == 1
    assert unpack('<2I', machine.mem_read(args+48, 8)) == (1, 1)
    assert machine.mem_read(mode, 1) == bytes([int(value)])
print('Queue style command returns through the full native layout bridge with preserved stack and registers.')
