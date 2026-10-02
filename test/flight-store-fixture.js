const SCHEDULES = [
  { id: 'MCT-DOH-WY669', origin: 'MCT', destination: 'DOH', cabin_class: 'economy', departure_minutes: 390, duration_minutes: 95, stops: [], numbers: ['WY 669'], base_fare: 980 },
  { id: 'MCT-DOH-EY385', origin: 'MCT', destination: 'DOH', cabin_class: 'economy', departure_minutes: 850, duration_minutes: 210, stops: ['AUH'], numbers: ['EY 385', 'EY 661'], base_fare: 860 },
  { id: 'MCT-DOH-QR1127', origin: 'MCT', destination: 'DOH', cabin_class: 'business', departure_minutes: 1080, duration_minutes: 100, stops: [], numbers: ['QR 1127'], base_fare: 3510 },
  { id: 'DOH-MCT-WY668', origin: 'DOH', destination: 'MCT', cabin_class: 'economy', departure_minutes: 470, duration_minutes: 95, stops: [], numbers: ['WY 668'], base_fare: 940 },
  { id: 'DOH-MCT-EY662', origin: 'DOH', destination: 'MCT', cabin_class: 'economy', departure_minutes: 790, duration_minutes: 220, stops: ['AUH'], numbers: ['EY 662', 'EY 386'], base_fare: 820 },
  { id: 'DOH-MCT-QR1126', origin: 'DOH', destination: 'MCT', cabin_class: 'business', departure_minutes: 1050, duration_minutes: 100, stops: [], numbers: ['QR 1126'], base_fare: 3420 },
];

const AIRPORTS = {
  MCT: { code: 'MCT', name: 'Muscat International Airport', city: 'Muscat', country: 'Oman', timezone: 'Asia/Muscat' },
  DOH: { code: 'DOH', name: 'Hamad International Airport', city: 'Doha', country: 'Qatar', timezone: 'Asia/Qatar' },
};

function isOperatingDay(date) {
  return [1, 3, 6].includes(new Date(`${date}T00:00:00.000Z`).getUTCDay());
}

function fares(schedule) {
  if (schedule.cabin_class === 'business') {
    return [
      { code: 'BUSINESS_COMFORT', name: 'Business Comfort', price: schedule.base_fare, seats_available: 6, cabin_baggage_pieces: 2, cabin_baggage_kg: 7, checked_baggage_kg: 40, change_policy: 'fees_apply', cancellation_policy: 'fees_apply' },
      { code: 'BUSINESS_FLEX', name: 'Business Flex', price: schedule.base_fare + 420, seats_available: 5, cabin_baggage_pieces: 2, cabin_baggage_kg: 7, checked_baggage_kg: 50, change_policy: 'allowed', cancellation_policy: 'fees_apply' },
    ];
  }
  return [
    { code: 'ECONOMY_SUPER_SAVER', name: 'Economy Super Saver', price: schedule.base_fare, seats_available: 8, cabin_baggage_pieces: 1, cabin_baggage_kg: 7, checked_baggage_kg: null, change_policy: 'fees_apply', cancellation_policy: 'non_refundable' },
    { code: 'ECONOMY_COMFORT', name: 'Economy Comfort', price: schedule.base_fare + 60, seats_available: 7, cabin_baggage_pieces: 1, cabin_baggage_kg: 7, checked_baggage_kg: 20, change_policy: 'fees_apply', cancellation_policy: 'fees_apply' },
    { code: 'ECONOMY_FLEX', name: 'Economy Flex', price: schedule.base_fare + 185, seats_available: 6, cabin_baggage_pieces: 1, cabin_baggage_kg: 7, checked_baggage_kg: 30, change_policy: 'allowed', cancellation_policy: 'fees_apply' },
  ];
}

export function createFlightStoreFixture() {
  return {
    async airport(code) { return AIRPORTS[code]; },
    async flights(origin, destination, date) {
      if (!isOperatingDay(date)) return [];
      return SCHEDULES.filter((schedule) => (
        schedule.origin === origin && schedule.destination === destination
      )).map((schedule) => ({
        ...schedule,
        id: `${schedule.id}-${date.replaceAll('-', '')}`,
        stop_airports_json: JSON.stringify(schedule.stops),
        flight_numbers_json: JSON.stringify(schedule.numbers),
        seats_left: 8,
        fares: fares(schedule),
      }));
    },
    async offer(inventoryId, fareCode) {
      const dateMatch = inventoryId.match(/-(\d{4})(\d{2})(\d{2})$/);
      if (!dateMatch) return undefined;
      const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      const schedule = SCHEDULES.find(({ id }) => inventoryId.startsWith(`${id}-`));
      if (!schedule) return undefined;
      const rows = await this.flights(schedule.origin, schedule.destination, date);
      const row = rows.find((flight) => flight.id === inventoryId);
      const fare = row?.fares.find((item) => item.code === fareCode);
      if (!row || !fare) return undefined;
      return {
        ...row, ...fare, status: 'scheduled',
        origin_code: schedule.origin, destination_code: schedule.destination,
        fare_code: fare.code, fare_name: fare.name,
      };
    },
    async lowestFares(origin, destination, startDate, endDate) {
      const routeSchedules = SCHEDULES.filter((schedule) => (
        schedule.origin === origin && schedule.destination === destination
      ));
      if (routeSchedules.length === 0) return [];
      const lowestPrice = Math.min(...routeSchedules.map((schedule) => schedule.base_fare));
      const rows = [];
      const date = new Date(`${startDate}T00:00:00.000Z`);
      const end = new Date(`${endDate}T00:00:00.000Z`);
      while (date <= end) {
        const isoDate = date.toISOString().slice(0, 10);
        if (isOperatingDay(isoDate)) rows.push({ date: isoDate, lowest_price: lowestPrice });
        date.setUTCDate(date.getUTCDate() + 1);
      }
      return rows;
    },
  };
}
