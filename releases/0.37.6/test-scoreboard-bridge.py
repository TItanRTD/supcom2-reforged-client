"""Run the retail Lua callback and its new optional return through x86 emulation."""
import os
from pathlib import Path
from struct import pack, unpack
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ESP, UC_X86_REG_ESI

root = Path(__file__).resolve().parents[1]
hud = Path(os.environ.get('PACKAGED_NATIVE', root / 'payload/resources/native')) / 'hud'
machine = Uc(UC_ARCH_X86, UC_MODE_32)
for base, length in ((0x100000, 0x3000), (0x41b000, 0x1000), (0xbe4000, 0x1000),
                     (0x18ca000, 0x1000), (0x18f3000, 0x1000), (0x1d90000, 0x1000),
                     (0x1da5000, 0x4000)):
    machine.mem_map(base, length)

base = 0x1da5000
hook = 0x1da59de
extension = 0x1da8f00
bridge = bytearray((hud / 'presentation-x86.bin').read_bytes())
assert bridge[hook-base:hook-base+7] == bytes.fromhex('5eb805000000c3')
bridge[hook-base:hook-base+7] = b'\xe9' + pack('<i', extension-hook-5) + b'\x90\x90'
machine.mem_write(base, bytes(bridge))
machine.mem_write(extension, (hud / 'scoreboard-badges-x86.bin').read_bytes())

context, state, values, name = 0x100100, 0x100200, 0x100500, 0x100900
stack, done = 0x102000, 0x101000
machine.mem_write(context+0x7c, pack('<I', context+0x100))
machine.mem_write(context+0x100+0x1c, pack('<I', state+0x100))
state += 0x100
machine.mem_write(0x41b060, b'\xb8'+pack('<I', name)+b'\xc3')
machine.mem_write(0xbe4b70, b'\x31\xc0\xc3')
machine.mem_write(0x1d90ec0, pack('<I', 0x52353253))
machine.mem_write(0x1d90f38+7*25, b'TitanRT\0')
machine.mem_write(0x1d90ea0+7*4, pack('<f', 16.2))
machine.mem_write(0x1d90ef8+7, bytes([163]))

def execute(player, with_name=True):
    machine.mem_write(name, player.encode().ljust(32, b'\0'))
    machine.mem_write(state+0x20, pack('<2I', values+(8 if with_name else 0), values))
    machine.mem_write(values, pack('<I', 4) + bytes(60))
    machine.mem_write(stack, pack('<2I', done, context))
    machine.reg_write(UC_X86_REG_ESI, 0x87654321)
    machine.reg_write(UC_X86_REG_ESP, stack)
    machine.emu_start(0x1da5900, done, count=5000)
    assert machine.reg_read(UC_X86_REG_ESP) == stack+4
    assert machine.reg_read(UC_X86_REG_ESI) == 0x87654321
    count = machine.reg_read(UC_X86_REG_EAX)
    address = values + (8 if with_name else 0)
    assert unpack('<I', machine.mem_read(state+0x20, 4))[0] == address+8*count
    return [unpack('<If', machine.mem_read(address+8*i, 8)) for i in range(count)]

results = execute('TitanRT')
assert len(results) == 6 and results[-2][0] == 3 and abs(results[-2][1]-16.2) < 0.0001
assert results[-1] == (3, 163)
assert execute('TitanRT2')[-1][0] == 0
assert execute('TitanRT', False)[-1][0] == 0
machine.mem_write(0x1d90ef8+7, bytes(1))
assert len(execute('TitanRT')) == 5
print('Native rating and badge results preserve the original five-value stack contract for other calls.')
