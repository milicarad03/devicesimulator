const { DevicePresence } = require('../runtime/device-presence');
const {
  createMqttConnectOptions,
} = require('../transports/create-transport');

describe('device presence lifecycle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes ONLINE immediately and as a heartbeat, then stops the timer', () => {
    jest.useFakeTimers();
    const client = {
      connected: true,
      publish: jest.fn((_topic, _payload, _options, callback) => {
        callback?.(null);
      }),
    };
    const presence = new DevicePresence({
      client,
      deviceId: 'presence-1',
      heartbeatIntervalMs: 1_000,
      logger: { warn: jest.fn() },
      now: () => new Date('2026-09-01T12:00:00.000Z'),
      statusTopic: 'iot/devices/presence-1/status',
    });

    presence.start();
    jest.advanceTimersByTime(2_000);

    expect(client.publish).toHaveBeenCalledTimes(3);
    expect(client.publish).toHaveBeenLastCalledWith(
      'iot/devices/presence-1/status',
      JSON.stringify({
        deviceId: 'presence-1',
        timestamp: '2026-09-01T12:00:00.000Z',
        status: 'online',
        heartbeat: true,
      }),
      { qos: 1, retain: true },
      expect.any(Function),
    );

    presence.stopHeartbeat();
    jest.advanceTimersByTime(2_000);
    expect(client.publish).toHaveBeenCalledTimes(3);
  });

  it('configures a retained MQTT Last Will with OFFLINE status', () => {
    expect(
      createMqttConnectOptions(
        'presence-1',
        'iot/devices/presence-1/status',
        new Date('2026-09-01T12:00:00.000Z'),
      ),
    ).toEqual({
      will: {
        topic: 'iot/devices/presence-1/status',
        payload: JSON.stringify({
          deviceId: 'presence-1',
          timestamp: '2026-09-01T12:00:00.000Z',
          status: 'offline',
        }),
        qos: 1,
        retain: true,
      },
    });
  });
});
