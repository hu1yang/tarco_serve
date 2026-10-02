const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateLabel(date) {
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function timeLabel(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function mockOrder(orderId, { now = new Date() } = {}) {
  if (!ORDER_ID_PATTERN.test(orderId || '')) {
    throw new Error('orderId 格式无效');
  }

  const departure = new Date(now.getTime() + (2 * 60 * 60 * 1000));
  const arrival = new Date(departure.getTime() + (1 * 60 * 60 * 1000) + (55 * 60 * 1000));

  return {
    id: orderId,
    reference: 'TRC8F2',
    status: 'confirmed',
    segments: [
      {
        flightNumber: '3T 210',
        departure: {
          code: 'KRT',
          city: 'Khartoum',
          name: 'Khartoum International Airport',
        },
        arrival: {
          code: 'JED',
          city: 'Jeddah',
          name: 'King Abdulaziz International Airport',
        },
        departureAt: departure.toISOString(),
        departureDate: dateLabel(departure),
        departureTime: timeLabel(departure),
        arrivalTime: timeLabel(arrival),
        duration: '1h 55m',
        departureTerminal: '1',
        arrivalTerminal: 'N',
        aircraft: 'Boeing 737-800',
      },
    ],
    passengers: [
      {
        name: 'Mr. Hu Yang',
        ticketNumber: '220-8473920101',
        cabinClass: 'Economy',
        seat: '12A',
      },
    ],
    payment: {
      total: 1280,
      currency: 'SAR',
      method: 'Visa ending in 4242',
      transactionId: `PAY-${orderId}`,
    },
  };
}
