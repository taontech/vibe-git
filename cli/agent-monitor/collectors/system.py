"""System-level metrics collection."""

import psutil


def collect_system_info() -> dict:
    cpu = psutil.cpu_percent(interval=0.1)
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    boot_time = psutil.boot_time()
    temps = {}
    try:
        temps_data = psutil.sensors_temperatures()
        for name, entries in temps_data.items():
            if entries:
                temps[name] = round(entries[0].current, 1)
    except Exception:
        pass

    return {
        "cpu_percent": cpu,
        "cpu_count": psutil.cpu_count(logical=True),
        "cpu_count_physical": psutil.cpu_count(logical=False),
        "memory_used_gb": round(mem.used / 1024**3, 2),
        "memory_total_gb": round(mem.total / 1024**3, 2),
        "memory_percent": mem.percent,
        "swap_used_gb": round(swap.used / 1024**3, 2),
        "swap_total_gb": round(swap.total / 1024**3, 2),
        "temperature": temps,
    }
